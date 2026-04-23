const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = 3000;

// --- 1. CONFIGURATION TURSO (SQLITE EN LIGNE) ---
// On remplace le stockage local par la connexion distante
const sequelize = new Sequelize({
    dialect: 'sqlite',
    dialectModule: require('@libsql/sqlite3'), // Utilise le driver Turso
    storage: 'VOTRE_URL_TURSO?authToken=VOTRE_TOKEN_TURSO', // Format Turso
    logging: false
});

// --- 2. MODÈLES DE DONNÉES (Inchangés) ---
const User = sequelize.define('User', {
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, unique: true, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
    isAdmin: { type: DataTypes.BOOLEAN, defaultValue: false }
});

const Product = sequelize.define('Product', {
    name: { type: DataTypes.STRING, allowNull: false },
    price: { type: DataTypes.FLOAT, allowNull: false },
    unit: { type: DataTypes.STRING, defaultValue: 'kg' },
    image: { type: DataTypes.STRING, defaultValue: '/default-veg.png' },
    stock: { type: DataTypes.FLOAT, defaultValue: 0 }
});

const Order = sequelize.define('Order', {
    userName: DataTypes.STRING,
    cart: { type: DataTypes.TEXT }, 
    status: { type: DataTypes.STRING, defaultValue: 'En attente' },
    date: { type: DataTypes.DATE, defaultValue: Sequelize.NOW }
});

const Arrivage = sequelize.define('Arrivage', {
    items: { type: DataTypes.TEXT } 
});

// Synchronisation avec Turso
sequelize.sync()
    .then(() => console.log("✅ Connecté à la base de données Turso en ligne."))
    .catch(err => console.error("❌ Erreur de connexion Turso:", err));

// --- 3. CONFIGURATION SERVEUR ---
const storage = multer.diskStorage({
    destination: 'public/uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'terre-de-bray-sql-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.isAdmin) return next();
    res.status(403).send("Accès réservé à l'admin.");
};

// --- 4. ROUTES AUTHENTIFICATION (Inchangées) ---
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const userCount = await User.count();
        await User.create({
            name, email, password: hashedPassword,
            isAdmin: userCount === 0 || email === 'admin@terrebray.fr'
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = { id: user.id, name: user.name, isAdmin: user.isAdmin };
        res.json({ success: true, name: user.name, isAdmin: user.isAdmin });
    } else { res.status(401).json({ message: "Erreur d'identifiants." }); }
});

app.get('/api/me', (req, res) => {
    res.json(req.session.user ? { loggedIn: true, ...req.session.user } : { loggedIn: false });
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// --- 5. ROUTES BOUTIQUE (Inchangées) ---
app.get('/api/products', async (req, res) => {
    res.json(await Product.findAll());
});

app.get('/api/arrivage', async (req, res) => {
    const data = await Arrivage.findOne({ order: [['createdAt', 'DESC']] });
    res.json(data ? JSON.parse(data.items) : []);
});

app.post('/api/order', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ message: "Connectez-vous." });
    await Order.create({
        userName: req.session.user.name,
        cart: JSON.stringify(req.body.cart)
    });
    res.json({ ok: true });
});

// --- 6. ROUTES ADMIN (Inchangées) ---
app.get('/api/admin/orders', isAdmin, async (req, res) => {
    try {
        const orders = await Order.findAll({ order: [['createdAt', 'DESC']] });
        const products = await Product.findAll();
        const productInfo = {};
        products.forEach(p => {
            productInfo[p.id] = { name: p.name, unit: p.unit };
        });

        const formatted = orders.map(o => {
            const orderJson = o.toJSON();
            const rawCart = JSON.parse(orderJson.cart);
            const cartDetails = [];
            for (let id in rawCart) {
                const info = productInfo[id] || { name: `Inconnu (ID:${id})`, unit: '' };
                cartDetails.push({ name: info.name, qty: rawCart[id], unit: info.unit });
            }
            orderJson.cartDetails = cartDetails;
            return orderJson;
        });
        res.json(formatted);
    } catch (e) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

app.post('/api/admin/approve-order', isAdmin, async (req, res) => {
    try {
        const { orderId } = req.body;
        const order = await Order.findByPk(orderId);
        if (!order || order.status !== 'En attente') return res.status(400).json({ message: "Commande déjà traitée." });

        const cart = JSON.parse(order.cart);
        for (const [productId, qty] of Object.entries(cart)) {
            const product = await Product.findByPk(productId);
            if (!product || product.stock < qty) return res.status(400).json({ message: `Stock insuffisant.` });
        }

        for (const [productId, qty] of Object.entries(cart)) {
            const product = await Product.findByPk(productId);
            await product.update({ stock: product.stock - qty });
        }

        await order.update({ status: 'Approuvée' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/add-product', isAdmin, upload.single('image'), async (req, res) => {
    await Product.create({
        name: req.body.name,
        price: parseFloat(req.body.price),
        unit: req.body.unit,
        stock: parseFloat(req.body.stock) || 0,
        image: req.file ? `/uploads/${req.file.filename}` : '/default-veg.png'
    });
    res.json({ success: true });
});

app.post('/api/admin/update-stock', isAdmin, async (req, res) => {
    const { id, stock } = req.body;
    await Product.update({ stock: parseFloat(stock) }, { where: { id } });
    res.json({ success: true });
});

app.delete('/api/admin/product/:id', isAdmin, async (req, res) => {
    await Product.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
});

app.post('/api/arrivage', isAdmin, async (req, res) => {
    const items = JSON.stringify(req.body.arrivage || []);
    await Arrivage.create({ items });
    res.json({ ok: true });
});

app.listen(PORT, () => console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`));