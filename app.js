const express = require('express');
const session = require('express-session');
const path = require('path');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config.json');

const app = express();
const port = config.port || 3000;
const projectSlug = config.slug;
const statsFile = path.join(__dirname, 'stats.json');
const groupCounterFile = path.join(__dirname, 'groupCounter.json');

function readStats() {
  try {
    return JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  } catch (err) {
    return { visitors: 0, transactions: 0, success: 0, failed: 0 };
  }
}

function writeStats(stats) {
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
}

function readGroupCounter() {
  try {
    return JSON.parse(fs.readFileSync(groupCounterFile, 'utf8')).index;
  } catch (err) {
    return 0;
  }
}

function writeGroupCounter(index) {
  fs.writeFileSync(groupCounterFile, JSON.stringify({ index }, null, 2));
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/admin')) {
    const stats = readStats();
    stats.visitors++;
    writeStats(stats);
  }
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  res.locals.owner = config.owner;
  // groupLink tidak lagi diset di locals karena digunakan per-order
  next();
});

const panelSizes = {
  "1GB": { ram: 1000, disk: 1000, cpu: 40 },
  "2GB": { ram: 2000, disk: 1000, cpu: 60 },
  "3GB": { ram: 3000, disk: 2000, cpu: 80 },
  "4GB": { ram: 4000, disk: 2000, cpu: 100 },
  "5GB": { ram: 5000, disk: 3000, cpu: 120 },
  "6GB": { ram: 6000, disk: 3000, cpu: 140 },
  "7GB": { ram: 7000, disk: 4000, cpu: 160 },
  "8GB": { ram: 8000, disk: 4000, cpu: 180 },
  "9GB": { ram: 9000, disk: 5000, cpu: 200 },
  "10GB": { ram: 10000, disk: 5000, cpu: 220 },
  "UNLI": { ram: 0, disk: 0, cpu: 0 }
};

let { apiUrl, apiKey } = config.pakasir;
let harga = { ...config.harga };
let pterodactylConfig = { ...config.pterodactyl.do };

function calculatePanelPrice(size) {
  const pricePerGb = harga.panel_do_per_gb;
  const unliPrice = harga.unli_do;
  if (size === 'UNLI') return unliPrice;
  if (panelSizes[size]) return parseInt(size) * pricePerGb;
  return null;
}

async function createPakasirTransaction(orderId, amount, description) {
  const response = await fetch(`${apiUrl}/api/transactioncreate/qris`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: projectSlug,
      order_id: orderId,
      amount: amount,
      api_key: apiKey
    })
  });
  if (!response.ok) throw new Error(`PaKasir error: ${response.status}`);
  const data = await response.json();
  if (!data.payment) throw new Error('PaKasir response missing payment data');
  return {
    transactionId: orderId,
    qrString: data.payment.payment_number,
    expiredAt: data.payment.expired_at
  };
}

async function checkPakasirStatus(orderId, amount) {
  const url = `${apiUrl}/api/transactiondetail?project=${projectSlug}&amount=${amount}&order_id=${orderId}&api_key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PaKasir error: ${response.status}`);
  const data = await response.json();
  if (!data.transaction) throw new Error('PaKasir response missing transaction data');
  return data.transaction.status;
}

async function createPterodactylAccount(order) {
  const { username, panelSize, name: packageName } = order;
  if (!username) throw new Error('Username tidak tersedia');
  const dataPaket = panelSize === 'UNLI' ? { ram: 0, disk: 0, cpu: 0 } : panelSizes[panelSize];
  if (!dataPaket) throw new Error('Ukuran panel tidak valid');

  const { domain, api_key, nest_id, egg_id, location_id, docker_image } = pterodactylConfig;
  const email = username + '@gmail.com';
  const randomDigits = crypto.randomInt(100000, 999999);
  const password = username + randomDigits;
  const firstName = username.charAt(0).toUpperCase() + username.slice(1);

  const checkUserRes = await fetch(`${domain}/api/application/users?filter[email]=${encodeURIComponent(email)}`, {
    headers: { 'Authorization': `Bearer ${api_key}` }
  });
  const checkUserData = await checkUserRes.json();
  if (checkUserData.data && checkUserData.data.length > 0) {
    throw new Error('Username atau email sudah terdaftar di panel');
  }

  const createUserRes = await fetch(`${domain}/api/application/users`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api_key}`
    },
    body: JSON.stringify({
      email,
      username,
      first_name: firstName,
      last_name: 'Panel',
      language: 'en',
      password
    })
  });

  const userData = await createUserRes.json();
  if (userData.errors) throw new Error(JSON.stringify(userData.errors[0]));
  const user = userData.attributes;

  const eggRes = await fetch(`${domain}/api/application/nests/${nest_id}/eggs/${egg_id}`, {
    headers: { 'Authorization': `Bearer ${api_key}` }
  });
  const eggData = await eggRes.json();
  const startup_cmd = eggData.attributes.startup;

  const createServerRes = await fetch(`${domain}/api/application/servers`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api_key}`
    },
    body: JSON.stringify({
      name: firstName,
      description: `Panel ${packageName} - ${username}`,
      user: user.id,
      egg: egg_id,
      startup: startup_cmd,
      docker_image: docker_image,
      environment: { CMD_RUN: 'npm start' },
      limits: {
        memory: dataPaket.ram,
        swap: 0,
        disk: dataPaket.disk,
        io: 500,
        cpu: dataPaket.cpu
      },
      feature_limits: { databases: 5, backups: 5, allocations: 5 },
      deploy: {
        locations: [location_id],
        dedicated_ip: false,
        port_range: []
      }
    })
  });

  const serverData = await createServerRes.json();
  if (serverData.errors) throw new Error(JSON.stringify(serverData.errors[0]));

  return { email, username, password, domain };
}

function autoCancelOrders(req, res, next) {
  if (req.session.orders) {
    const now = Date.now();
    req.session.orders.forEach(order => {
      if (order.status === 'pending' && now - order.createdAt > 5 * 60 * 1000) {
        order.status = 'cancelled';
      }
    });
  }
  next();
}

app.use(autoCancelOrders);

function checkPendingOrder(req, res, next) {
  if (req.session.orders) {
    const pending = req.session.orders.find(o => o.status === 'pending');
    if (pending) return res.redirect(`/payment/${pending.id}`);
  }
  next();
}

function isAdmin(req, res, next) {
  if (req.session.admin) {
    next();
  } else {
    res.redirect('/admin/login');
  }
}

app.get('/', (req, res) => res.redirect('/plans'));

app.get('/plans', checkPendingOrder, (req, res) => {
  res.render('order', { harga });
});

app.get('/history', (req, res) => {
  res.render('history');
});

app.get('/panel', checkPendingOrder, (req, res) => {
  const pricePerGb = harga.panel_do_per_gb;
  const unliPrice = harga.unli_do;
  res.render('panel', { pricePerGb, panelSizes, unliPrice });
});

app.get('/group', checkPendingOrder, (req, res) => {
  const pkg = {
    id: 'group-monthly',
    name: 'Sewa Grup (1 Bulan)',
    price: harga.group_price,
    currency: 'IDR',
    isGroup: true
  };
  res.render('checkout-group', { pkg });
});

app.get('/checkout/:size', checkPendingOrder, (req, res) => {
  const size = req.params.size;
  if (!panelSizes[size]) return res.redirect('/plans');

  const pricePerGb = harga.panel_do_per_gb;
  const unliPrice = harga.unli_do;
  let price, name, specs;

  if (size === 'UNLI') {
    price = unliPrice;
    name = `Panel DigitalOcean Unlimited`;
    specs = 'RAM Unli, Disk Unli, CPU Unli';
  } else {
    const data = panelSizes[size];
    price = parseInt(size) * pricePerGb;
    name = `Panel DigitalOcean ${size}`;
    specs = `${data.ram} MB RAM, ${data.disk} MB Disk, ${data.cpu}% CPU`;
  }

  const pkg = {
    id: `panel-${size}`,
    name,
    specs,
    price,
    currency: 'IDR',
    isPanel: true,
    panelSize: size
  };

  res.render('checkout', { pkg });
});

app.post('/api/create-order', async (req, res) => {
  const { packageId, name, price, currency, specs, username } = req.body;

  let calculatedPrice, isPanel = false, isGroup = false, panelSize = null;

  if (packageId.startsWith('panel-')) {
    isPanel = true;
    panelSize = packageId.split('-')[1];
    calculatedPrice = calculatePanelPrice(panelSize);
    if (!calculatedPrice) return res.status(400).json({ error: 'Paket tidak valid' });
    if (price !== calculatedPrice) return res.status(400).json({ error: 'Harga tidak cocok' });
    if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username hanya huruf, angka, underscore, 3-20 karakter' });
    }
  } else if (packageId === 'group-monthly') {
    isGroup = true;
    calculatedPrice = harga.group_price;
    if (price !== calculatedPrice) return res.status(400).json({ error: 'Harga tidak cocok' });
  } else {
    return res.status(400).json({ error: 'Paket tidak valid' });
  }

  if (req.session.orders) {
    const existing = req.session.orders.find(o => o.packageId === packageId && o.status === 'pending');
    if (existing) return res.json({ orderId: existing.id, qrCode: existing.qrCode });
  }

  const orderId = `${projectSlug}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  try {
    const pakasir = await createPakasirTransaction(orderId, price, name);
    const qrDataUrl = await QRCode.toDataURL(pakasir.qrString);

    const order = {
      id: orderId,
      packageId,
      name,
      price,
      currency,
      specs: specs || '',
      status: 'pending',
      qrCode: qrDataUrl,
      createdAt: Date.now(),
      isPanel,
      isGroup,
      panelSize,
      username: username || null
    };

    if (!req.session.orders) req.session.orders = [];
    req.session.orders.push(order);

    const stats = readStats();
    stats.transactions++;
    writeStats(stats);

    res.json({ orderId, qrCode: qrDataUrl });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(500).json({ error: 'Gagal membuat transaksi di PaKasir' });
  }
});

app.post('/api/order/:id/cancel', (req, res) => {
  const orderId = req.params.id;
  if (req.session.orders) {
    const idx = req.session.orders.findIndex(o => o.id === orderId && o.status === 'pending');
    if (idx !== -1) {
      req.session.orders[idx].status = 'cancelled';
      const stats = readStats();
      stats.failed++;
      writeStats(stats);
      return res.json({ success: true });
    }
  }
  res.status(404).json({ error: 'Order tidak ditemukan' });
});

app.get('/payment/:id', (req, res) => {
  const order = req.session.orders?.find(o => o.id == req.params.id);
  if (!order || order.status !== 'pending') return res.redirect('/plans');
  res.render('payment', { order });
});

app.get('/api/order/:id/status', async (req, res) => {
  const order = req.session.orders?.find(o => o.id == req.params.id);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

  if (order.status !== 'success') {
    try {
      const status = await checkPakasirStatus(order.id, order.price);
      if (status === 'completed') {
        if (order.isPanel && !order.panelCreated && !order.panelCreating) {
          order.panelCreating = true;
          try {
            const credentials = await createPterodactylAccount(order);
            order.panelCredentials = credentials;
            order.panelCreated = true;
          } catch (err) {
            console.error('Gagal membuat panel:', err);
            order.panelError = err.message;
          } finally {
            delete order.panelCreating;
          }
        }
        // Untuk order grup, tentukan link berdasarkan counter
        if (order.isGroup) {
          const currentIndex = readGroupCounter();
          order.groupLink = currentIndex === 0 ? config.groupLink1 : config.groupLink2;
          const nextIndex = currentIndex === 0 ? 1 : 0;
          writeGroupCounter(nextIndex);
        }
        order.status = 'success';
        const stats = readStats();
        stats.success++;
        writeStats(stats);
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Gagal cek status' });
    }
  }
  res.json({ status: order.status });
});

app.get('/api/order/:id/detail', (req, res) => {
  const order = req.session.orders?.find(o => o.id == req.params.id);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  res.json({
    id: order.id,
    name: order.name,
    price: order.price,
    currency: order.currency,
    status: order.status,
    isPanel: order.isPanel,
    isGroup: order.isGroup,
    panelCredentials: order.panelCredentials,
    panelError: order.panelError,
    groupLink: order.groupLink,
    createdAt: order.createdAt
  });
});

app.get('/success', (req, res) => {
  const orderId = req.query.orderId;
  const order = req.session.orders?.find(o => o.id == orderId);
  res.render('success', { order });
});

app.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === config.admin.username && password === config.admin.password) {
    req.session.admin = true;
    res.redirect('/admin/dashboard');
  } else {
    res.render('admin/login', { error: 'Username atau password salah' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin/dashboard', isAdmin, (req, res) => {
  const stats = readStats();
  res.render('admin/dashboard', { stats, harga, pterodactylConfig, apiUrl, apiKey, config });
});

app.post('/admin/update-settings', isAdmin, (req, res) => {
  const {
    harga_panel_do_per_gb, unli_do, group_price,
    pakasir_api_key,
    pterodactyl_domain, pterodactyl_api_key, pterodactyl_nest_id, pterodactyl_egg_id, pterodactyl_location_id, pterodactyl_docker_image,
    group_link1, group_link2
  } = req.body;

  config.harga.panel_do_per_gb = parseInt(harga_panel_do_per_gb);
  config.harga.unli_do = parseInt(unli_do);
  config.harga.group_price = parseInt(group_price);
  if (pakasir_api_key) config.pakasir.apiKey = pakasir_api_key;

  config.pterodactyl.do.domain = pterodactyl_domain;
  if (pterodactyl_api_key) config.pterodactyl.do.api_key = pterodactyl_api_key;
  config.pterodactyl.do.nest_id = parseInt(pterodactyl_nest_id);
  config.pterodactyl.do.egg_id = parseInt(pterodactyl_egg_id);
  config.pterodactyl.do.location_id = parseInt(pterodactyl_location_id);
  config.pterodactyl.do.docker_image = pterodactyl_docker_image;

  if (group_link1) config.groupLink1 = group_link1;
  if (group_link2) config.groupLink2 = group_link2;

  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));

  apiKey = config.pakasir.apiKey;
  harga = { ...config.harga };
  pterodactylConfig = { ...config.pterodactyl.do };

  res.redirect('/admin/dashboard');
});

app.use((req, res) => {
  res.status(404).render('404');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});