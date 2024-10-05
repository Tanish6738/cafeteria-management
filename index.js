const express = require('express');
const app = express();
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcrypt');
const io = require('socket.io')();
const multer = require('multer');
const fs = require('fs');
const { promisify } = require('util');
const unlinkAsync = promisify(fs.unlink);
const jwt = require('jsonwebtoken');

// Models
const Users = require('./models/Users');
const Menu = require('./models/Menu');
const Orders = require('./models/Orders');
const Tables = require('./models/Table');
const OrderHistory = require('./models/OrderHistory');

// Connect to MongoDB with retry mechanism
const connectWithRetry = () => {
    mongoose.connect('mongodb://localhost:27017/Cafe')
        .then(() => console.log('Connected to MongoDB'))
        .catch(err => {
            console.error('Error connecting to MongoDB', err);
            // Retry after 5 seconds
            setTimeout(connectWithRetry, 5000);
        });
};
connectWithRetry();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'defaultSecretKey',  // Local secret key
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,  // Since this is local, no need for secure cookies
        httpOnly: true,
        maxAge: 1000 * 60 * 60 // 1 hour
    }
}));
app.use(flash());

// Set view engine
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));



// Flash messages middleware
app.use((req, res, next) => {
    res.locals.flashMessages = req.flash();
    res.locals.isAdmin = req.session.user && req.session.user.role === 'admin';
    res.locals.user = req.session.user; // Add this line to set the user variable
    next();
});


// Middleware to check if the user has a reserved table
const ensureTableReserved = async (req, res, next) => {
    const reservedTable = await Tables.findOne({ reservedBy: req.session.user._id, status: 'reserved' });
    if (reservedTable) {
        req.reservedTable = reservedTable; // Attach reserved table to request object
        return next();
    }
    setFlash(req, 'error_msg', 'Please reserve a table before placing an order');
    return res.redirect('/tables');
};

// Authentication middleware
const ensureAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    }
    req.flash('error_msg', 'Please log in to view that resource');
    return res.redirect('/login');
};

const ensureAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    req.flash('error_msg', 'Admin access only');
    return res.redirect('/login');
};

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const setFlash = (req, type, msg) => {
    req.flash(type, msg);
};

// Multer setup for file uploads

// Set storage engine
const storage = multer.diskStorage({
    destination: path.join(__dirname, 'public', 'uploads'),  // Use path.join with __dirname
    filename: function (req, file, cb) {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});


// Initialize upload
const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    }
});

// Check file type
function checkFileType(file, cb) {
    const filetypes = /jpeg|jpg|png|gif/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (mimetype && extname) {
        return cb(null, true);
    } else {
        cb('Error: Images Only!');
    }
}

// Integrate Socket.io
const server = require('http').createServer(app);
io.attach(server);

io.on('connection', socket => {
    socket.on('tableStatusChanged', data => {
        io.emit('updateTableStatus', data);
    });

    socket.on('orderStatusChanged', data => {
        io.emit('updateOrderStatus', data);
    });

    socket.on('orderUpdate', data => {
        io.emit('notifyOrderUpdate', data);
    });

    socket.on('error', (err) => {
        console.error('Socket.io error:', err);
    });
});

// Home Route
app.get('/', async (req, res) => {
    const { user } = req.session;
    try {
        const menuItems = await Menu.find();
        setFlash(req, 'success_msg', 'Welcome to the Cafe');
        if (user && user.role === 'admin') {
            res.render('home', { menuItems });
        } else {
            res.render('home', { menuItems });
        }
    } catch (err) {
        console.error('Error fetching menu items:', err);
        setFlash(req, 'error_msg', 'An error occurred while fetching menu items');
        res.redirect('/login');
    }
});

// Authentication
app.get('/login', (req, res) => {
    res.render('auth/login');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/register', (req, res) => {
    res.render('auth/register');
});

app.post('/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await Users.findOne({ email });
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.user = user;
        setFlash(req, 'success_msg', 'You are now logged in');
        return req.session.user.role === 'admin' ? res.redirect('/admin/menu') : res.redirect('/customer/menu');
    } else {
        setFlash(req, 'error_msg', 'Invalid email or password');
        return res.redirect('/login');
    }
}));

app.post('/register', asyncHandler(async (req, res) => {
    const { username, email, password, mobile } = req.body;
    console.log('Registering user:', username, email, mobile);
    const hashedPassword = await bcrypt.hash(password, 15);
    const newUser = new Users({ username, email, password: hashedPassword, mobile });
    await newUser.save();
    setFlash(req, 'success_msg', 'You are now registered and can log in');
    return res.redirect('/login');
}));


// Admin Routes and Features

// Admin Menu Management
app.get('/admin/menu', ensureAuthenticated, asyncHandler(async (req, res) => {
    const menuItems = await Menu.find();
    res.render('menu/adminMenu', { menuItems });
}));

app.get('/admin/menu/addMenuItem', ensureAdmin, (req, res) => {
    res.render('menu/addMenuItem');
});

app.post('/admin/menu/addMenuItem', ensureAdmin, upload.single('image'), asyncHandler(async (req, res) => {
    const { name, price, description, category, available, stock } = req.body;
    const image = req.file ? path.relative(path.join(__dirname, 'public'), req.file.path) : '';
    const newMenuItem = new Menu({ name, price, description, image, category, available, stock });
    await newMenuItem.save();
    setFlash(req, 'success_msg', 'Menu item added successfully');
    return res.redirect('/admin/menu');
}));

app.get('/admin/menu/:id/edit', ensureAdmin, asyncHandler(async (req, res) => {
    const menuItem = await Menu.findById(req.params.id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/admin/menu');
    }
    res.render('menu/editMenuItem', { menuItem });
}));

app.post('/admin/menu/:id/edit', ensureAdmin, upload.single('image'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const menuItem = await Menu.findById(id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/admin/menu');
    }
    const { name, price, description, category, available, stock } = req.body;
    const image = req.file ? req.file.path : menuItem.image;
    if (req.file && menuItem.image && fs.existsSync(menuItem.image)) {
        await unlinkAsync(menuItem.image);
    }
    await Menu.findByIdAndUpdate(id, { name, price, description, image, category, available, stock });
    setFlash(req, 'success_msg', 'Menu item updated successfully');
    return res.redirect('/admin/menu');
}));

app.get('/menu/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    const menuItem = await Menu.findById(req.params.id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/admin/menu');
    }
    res.render('menu/menuItem', { menuItem });
}));

app.get('/admin/menu/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const menuItem = await Menu.findById(id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/admin/menu');
    }
    await Menu.findByIdAndDelete(id);
    if (menuItem.image && fs.existsSync(menuItem.image)) {
        await unlinkAsync(menuItem.image);
    }
    setFlash(req, 'success_msg', 'Menu item deleted successfully');
    return res.redirect('/admin/menu');
}));

app.post('/admin/menu/:id/toggle-availability', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const menuItem = await Menu.findById(id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/admin/menu');
    }
    menuItem.available = !menuItem.available;
    await menuItem.save();
    setFlash(req, 'success_msg', 'Menu item availability toggled successfully');
    return res.redirect('/admin/menu');
}));

// Admin Orders Management
app.get("/admin/orders", ensureAdmin, asyncHandler(async (req, res) => {
    const orders = await Orders.find().populate('items.menuItem').populate('customer');
    res.render('orders/adminOrders', { orders });
}));

app.get('/admin/orders/history', ensureAdmin, asyncHandler(async (req, res) => {
    try {
        // Fetch all completed orders from OrderHistory
        const ordersHistory = await OrderHistory.find()
            .populate('items.menuItem')
            .populate('customer')
            .lean(); // Use lean() for faster Mongoose queries and to work with plain JavaScript objects

        // Fetch all orders from Orders
        const orders = await Orders.find()
            .populate('items.menuItem')
            .populate('customer')
            .lean();

        // Create a map of Orders by _id for quick lookup
        const ordersMap = {};
        orders.forEach(order => {
            ordersMap[order._id.toString()] = order;
        });

        // Merge OrderHistory with corresponding Orders data
        const mergedOrders = ordersHistory.map(orderHistory => {
            const correspondingOrder = ordersMap[orderHistory._id.toString()];
            return {
                ...orderHistory,
                placedAt: correspondingOrder ? correspondingOrder.placedAt : null,
                updatedAt: correspondingOrder ? correspondingOrder.updatedAt : null,
            };
        });

        // Render the admin order history page with the merged orders
        res.render('orders/adminOrderHistory', { orders: mergedOrders });
    } catch (error) {
        console.error('Error fetching order history:', error);
        req.flash('error_msg', 'Failed to load order history.');
        res.redirect('/admin/dashboard'); // Redirect to an appropriate page
    }
}));


app.get('/admin/orders/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const order = await OrderHistory.findById(req.params.id)
            .populate('items.menuItem')
            .populate('customer')
            .lean();

        if (!order) {
            setFlash(req, 'error_msg', 'Order not found');
            return res.redirect('/admin/orders/history');
        }

        res.render('orders/orderDetails', { order });
    } catch (error) {
        // Catch any potential errors and handle them
        console.error('Error fetching order:', error);
        setFlash(req, 'error_msg', 'Error fetching order details');
        return res.redirect('/admin/orders/history');
    }
}));

app.post('/orders/:id/update-status', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'preparing', 'ready', 'served', 'completed', 'canceled'];
    if (!validStatuses.includes(status)) {
        setFlash(req, 'error_msg', 'Invalid order status');
        return res.redirect('/admin/orders');
    }

    const order = await Orders.findById(id);
    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/admin/orders');
    }

    if (status === 'completed') {
        // Move the order to order history
        const orderHistory = new OrderHistory({
            items: order.items,
            tableNumber: order.tableNumber,
            total: order.total,
            customer: order.customer,
            status: 'completed'
        });

        await orderHistory.save(); // Save to the order history collection
        await Orders.findByIdAndDelete(id); // Remove from current orders

        setFlash(req, 'success_msg', 'Order marked as completed and moved to history');
        return res.redirect('/admin/orders'); // Redirect to the orders page
    }

    order.status = status; // Update other statuses
    await order.save();

    setFlash(req, 'success_msg', 'Order status updated successfully');
    return res.redirect('/admin/orders');
}));

app.get('/admin/orders/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const order = await Orders.findById(id);
    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/orders');
    }
    await Orders.findByIdAndDelete(id);
    setFlash(req, 'success_msg', 'Order deleted successfully');
    return res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/mark-as-served', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const order = await Orders.findById(id);
    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/admin/orders');
    }
    order.status = 'served';
    await order.save();
    setFlash(req, 'success_msg', 'Order marked as served');
    return res.redirect('/admin/orders');
}));

app.post('/admin/orders/:id/approve-payment', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const order = await Orders.findById(id);

    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/admin/orders');
    }

    // Check if the order is already paid
    if (order.isPaid) {
        setFlash(req, 'error_msg', 'Payment is already approved for this order');
        return res.redirect('/admin/orders');
    }

    // Mark the order as paid
    order.isPaid = true;
    await order.save();

    // Find the table and update its status to 'vacant'
    const table = await Tables.findOne({ tableNumber: order.tableNumber, status: 'reserved' });
    if (table) {
        table.status = 'vacant';  // Mark the table as unreserved
        table.reservedBy = null;  // Clear the reservation
        await table.save();
    }

    setFlash(req, 'success_msg', 'Payment approved and table is now vacant');
    return res.redirect('/admin/orders');
}));

// Admin User Management
app.get('/admin/users', ensureAdmin, asyncHandler(async (req, res) => {
    const users = await Users.find();
    const usersWithOrderInfo = await Promise.all(users.map(async (user) => {
        const orders = await Orders.find({ customer: user._id });
        const orderCount = orders.length;
        const unpaidOrders = orders.filter(order => order.paymentStatus !== 'paid').length;
        return {
            ...user.toObject(),
            orderCount,
            unpaidOrders
        };
    }));
    res.render('admin/adminUsers', { users: usersWithOrderInfo });
}));

app.get('/admin/users/:id', ensureAdmin, asyncHandler(async (req, res) => {
    const user = await Users.findById(req.params.id)
        .populate({
            path: 'orders',
            populate: {
                path: 'items.menuItem',
                model: 'Menu'
            }
        })
        .populate('paymentHistory.orderId');

    if (!user) {
        setFlash(req, 'error_msg', 'User not found');
        return res.redirect('/admin/users');
    }

    const orders = await Orders.find({ customer: user._id })
        .populate({
            path: 'items.menuItem',
            model: 'Menu'
        });

    const orderCount = orders.length;
    const unpaidOrders = orders.filter(order => order.paymentStatus !== 'paid').length;

    res.render('admin/adminUserDetails', { user, orders, orderCount, unpaidOrders });
}));


app.get('/admin/users/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    await Users.findByIdAndDelete(req.params.id);
    setFlash(req, 'success_msg', 'User deleted successfully');
    return res.redirect('/admin/users');
}));

// Admin Table Management
app.get('/tables/new', ensureAdmin, (req, res) => {
    res.render('tables/addTable');
});

app.post('/tables/new', ensureAdmin, async (req, res) => {
    const { tableNumber, capacity, status } = req.body;
    console.log('Received data:', { tableNumber, capacity, status });
    if (!tableNumber || !capacity || !status) {
        setFlash(req, 'error_msg', 'Table number, capacity, and status are required');
        return res.redirect('/tables/new');
    }
    const existingTable = await Tables.findOne({ tableNumber });
    if (existingTable) {
        setFlash(req, 'error_msg', 'Table already exists');
        return res.redirect('/tables/new');
    }
    const newTable = new Tables({ tableNumber, capacity, status });
    await newTable.save();
    setFlash(req, 'success_msg', 'Table added successfully');
    res.redirect('/tables');
});

app.get('/tables/:id/edit', ensureAdmin, asyncHandler(async (req, res) => {
    const table = await Tables.findById(req.params.id);
    if (!table) {
        setFlash(req, 'error_msg', 'Table not found');
        return res.redirect('/tables');
    }
    res.render('tables/editTable', { table });
}));

app.post('/tables/:id/edit', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { tableNumber, capacity, status } = req.body;

    console.log(`Editing table with ID: ${id}`);
    console.log(`Received data:`, { tableNumber, capacity, status });

    if (!tableNumber || !capacity || !status) {
        console.log('Validation failed: All fields are required');
        setFlash(req, 'error_msg', 'All fields are required');
        return res.redirect(`/tables/${id}/edit`);
    }

    await Tables.findByIdAndUpdate(id, { tableNumber, capacity, status });
    console.log(`Table with ID: ${id} updated successfully`);
    setFlash(req, 'success_msg', 'Table updated successfully');
    return res.redirect('/tables');
}));

app.get('/tables/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const table = await Tables.findById(id);
    if (!table) {
        setFlash(req, 'error_msg', 'Table not found');
        return res.redirect('/tables');
    }
    await Tables.findByIdAndDelete(id);
    setFlash(req, 'success_msg', 'Table deleted successfully');
    return res.redirect('/tables');
}));

// Customer Routes and Features

// Menu Browsing
app.get('/customer/menu', ensureAuthenticated, asyncHandler(async (req, res) => {
    const menuItems = await Menu.find();
    const reservedTable = await Tables.findOne({ reservedBy: req.session.user._id, status: 'reserved' });
    res.render('menu/customerMenu', { menuItems, reservedTable });
}));

app.get('/menu/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    const menuItem = await Menu.findById(req.params.id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/menu');
    }
    res.render('menu/menuItem', { menuItem });
}));


// Order Placement and Management
app.post('/cart/new', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { menuItemId, quantity } = req.body;

    console.log('Adding to cart:', { menuItemId, quantity });

    if (!menuItemId || !quantity) {
        console.log('Validation failed: Menu item and quantity are required');
        setFlash(req, 'error_msg', 'Menu item and quantity are required');
        return res.redirect('/customer/menu');
    }

    const cart = req.session.cart || [];
    const existingItem = cart.find(item => item.menuItemId === menuItemId);

    if (existingItem) {
        console.log(`Item ${menuItemId} already in cart, updating quantity`);
        existingItem.quantity += quantity;
    } else {
        console.log(`Item ${menuItemId} not in cart, adding new item`);
        cart.push({ menuItemId, quantity });
    }

    req.session.cart = cart;
    console.log('Cart updated:', cart);
    setFlash(req, 'success_msg', 'Item added to cart');
    return res.redirect('/customer/menu');
}));

app.post('/cart/update', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { menuItemId, quantity } = req.body;

    console.log('Updating cart:', { menuItemId, quantity });

    if (!menuItemId || quantity === undefined) {
        console.log('Validation failed: Menu item and quantity are required');
        setFlash(req, 'error_msg', 'Menu item and quantity are required');
        return res.redirect('/cart/view');
    }

    const cart = req.session.cart || [];
    const itemIndex = cart.findIndex(item => item.menuItemId === menuItemId);

    if (itemIndex > -1) {
        if (quantity > 0) {
            console.log(`Updating quantity of item ${menuItemId} to ${quantity}`);
            cart[itemIndex].quantity = quantity;
        } else {
            console.log(`Removing item ${menuItemId} from cart`);
            cart.splice(itemIndex, 1);
        }
    } else {
        console.log(`Item ${menuItemId} not found in cart`);
    }

    req.session.cart = cart;
    console.log('Cart updated:', cart);
    setFlash(req, 'success_msg', 'Cart updated');
    return res.redirect('/cart/view');
}));

app.get('/cart/view', ensureAuthenticated, asyncHandler(async (req, res) => {
    const cart = req.session.cart || [];
    const menuItems = await Menu.find({ _id: { $in: cart.map(item => item.menuItemId) } });
    const cartItems = cart.map(item => ({
        menuItem: menuItems.find(menuItem => menuItem._id.toString() === item.menuItemId),
        quantity: item.quantity
    }));
    const totalPrice = cart.reduce((total, item) => {
        const menuItem = menuItems.find(menuItem => menuItem._id.toString() === item.menuItemId);
        return total + (menuItem.price * item.quantity);
    }, 0);
    const tableNumberJson = await Tables.findOne({ reservedBy: req.session.user._id, status: 'reserved' });
    const tableNumber = tableNumberJson ? tableNumberJson.tableNumber : null;
    res.render('cart/viewCart', { cartItems, totalPrice, tableNumber });
}));

// route for increasing the quantity of the item in the cart
app.get('/cart/increment/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const cart = req.session.cart || [];
    const item = cart.find(item => item.menuItemId === id);
    if (item) {
        item.quantity++;
    }
    req.session.cart = cart;
    return res.redirect('/cart/view');
}));

// route for decreasing the quantity of the item in the cart
app.get('/cart/decrement/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const cart = req.session.cart || [];
    const item = cart.find(item => item.menuItemId === id);
    if (item && item.quantity > 1) {
        item.quantity--;
    }
    req.session.cart = cart;
    return res.redirect('/cart/view');
}));

// route for removing the item from the cart
app.get('/cart/remove/:id', ensureAuthenticated, asyncHandler(async (req, res) => {

    const { id } = req.params;
    const cart = req.session.cart || [];

    const itemIndex = cart.findIndex(item => item.menuItemId === id);
    if (itemIndex > -1) {
        cart.splice(itemIndex, 1);
    }

    req.session.cart = cart;
    return res.redirect('/cart/view');
}));

// route for clearing the cart
app.get('/cart/clear', ensureAuthenticated, asyncHandler(async (req, res) => {
    req.session.cart = [];
    return res.redirect('/cart/view');
}));

app.post('/orders/place', ensureAuthenticated, ensureTableReserved, asyncHandler(async (req, res) => {
    const { tableNumber, total } = req.body;
    const cart = req.session.cart || [];

    console.log('Placing order:', { tableNumber, total, cart });

    if (!cart.length || !tableNumber || !total) {
        console.log('Validation failed: All fields are required');
        setFlash(req, 'error_msg', 'All fields are required');
        return res.redirect('/cart/view');
    }

    const items = cart.map(item => ({
        menuItem: item.menuItemId,
        quantity: item.quantity
    }));

    console.log('Order items:', items);

    const newOrder = new Orders({ items, tableNumber, total, customer: req.session.user._id });
    try {
        await newOrder.save();
        await Users.findByIdAndUpdate(req.session.user._id, { $push: { orders: newOrder._id } });
        req.session.cart = []; // Clear the cart after placing the order
        console.log('Order placed successfully:', newOrder);
        setFlash(req, 'success_msg', 'Order placed successfully');
        return res.redirect('/customer/orders/' + newOrder._id);
    } catch (err) {
        console.error('Error saving new order:', err);
        setFlash(req, 'error_msg', 'Failed to place the order');
        return res.redirect('/cart/view');
    }
}));

app.post('/orders/cancel/:id', ensureAuthenticated, ensureTableReserved, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const order = await Orders.findById(id);

    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/customer/orders');
    }

    if (['ready', 'served'].includes(order.status)) {
        setFlash(req, 'error_msg', 'Orders that are ready or served cannot be canceled');
        return res.redirect('/customer/orders');
    }

    if (order.status !== 'pending') {
        setFlash(req, 'error_msg', 'Only pending orders can be canceled');
        return res.redirect('/customer/orders');
    }

    order.status = 'canceled';
    await order.save();
    setFlash(req, 'success_msg', 'Order canceled successfully');
    return res.redirect('/customer/orders');
}));

app.get('/customer/orders', ensureAuthenticated, ensureTableReserved, asyncHandler(async (req, res) => {
    const orders = await Orders.find({ customer: req.session.user._id }).populate('items.menuItem').populate('customer');
    res.render('orders/customerOrders', { orders });
}));

app.get('/customer/orders/:id', ensureAuthenticated, ensureTableReserved, asyncHandler(async (req, res) => {
    const order = await Orders.findById(req.params.id).populate('items.menuItem').populate('customer');
    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/customer/orders');
    }
    res.render('orders/orderDetails', { order });
}));

// Profile Management
app.get('/user/profile', ensureAuthenticated, asyncHandler(async (req, res) => {
    const user = await Users.findById(req.session.user._id)
        .populate({
            path: 'orders',
            populate: {
                path: 'items.menuItem',
                model: 'Menu'
            }
        })
        .populate('paymentHistory.orderId');

    // Separate current and previous orders based on status
    const currentOrders = user.orders.filter(order => 
        ['pending', 'preparing', 'served'].includes(order.status)
    );
    const previousOrders = user.orders.filter(order => 
        ['completed', 'canceled'].includes(order.status)
    );

    res.render('users/profile', { user, currentOrders, previousOrders });
}));

app.get('/user/profile/edit', ensureAuthenticated, asyncHandler(async (req, res) => {
    const user = await Users.findById(req.session.user._id);
    res.render('users/editProfile', { user });
}));

app.post('/user/profile', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { username, email, mobile } = req.body;
    await Users.findByIdAndUpdate(req.session.user._id, { username, email, mobile });
    setFlash(req, 'success_msg', 'Profile updated successfully');
    return res.redirect('/user/profile');
}));

app.get('/user/profile/delete', ensureAuthenticated, asyncHandler(async (req, res) => {
    await Users.findByIdAndDelete(req.session.user._id);
    req.session.destroy();
    setFlash(req, 'success_msg', 'Profile deleted successfully');
    return res.redirect('/login');
}));

app.get('/user/payment-history', ensureAuthenticated, asyncHandler(async (req, res) => {
    const user = await Users.findById(req.session.user._id).populate('paymentHistory.orderId');
    res.render('user/paymentHistory', { paymentHistory: user.paymentHistory });
}));

// route for generating the receipt
app.get('/customer/orders/:id/receipt', ensureAuthenticated, asyncHandler(async (req, res) => {
    const order = await Orders.findById(req.params.id).populate('items.menuItem').populate('customer');

    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/customer/orders');
    }

    // Calculate breakdowns
    const taxRate = 0.1; // 10% tax
    const serviceChargeRate = 0.05; // 5% service charge
    const subtotal = order.items.reduce((sum, item) => sum + item.menuItem.price * item.quantity, 0);
    const tax = subtotal * taxRate;
    const serviceCharge = subtotal * serviceChargeRate;
    const total = subtotal + tax + serviceCharge;

    order.subtotal = subtotal;
    order.tax = tax;
    order.serviceCharge = serviceCharge;
    order.total = total;

    res.render('orders/receipt', { order });
}));

app.get('/admin/orders/:id/receipt', ensureAdmin, asyncHandler(async (req, res) => {
    const order = await Orders.findById(req.params.id).populate('items.menuItem').populate('customer');

    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/customer/orders');
    }

    // Calculate breakdowns
    const taxRate = 0.1; // 10% tax
    const serviceChargeRate = 0.05; // 5% service charge
    const subtotal = order.items.reduce((sum, item) => sum + item.menuItem.price * item.quantity, 0);
    const tax = subtotal * taxRate;
    const serviceCharge = subtotal * serviceChargeRate;
    const total = subtotal + tax + serviceCharge;

    order.subtotal = subtotal;
    order.tax = tax;
    order.serviceCharge = serviceCharge;
    order.total = total;

    res.render('orders/receipt', { order });
}));

// Table Reservation

// app.get('/tables/tableHistory', ensureAuthenticated , ensureAdmin 

app.get('/tables', ensureAuthenticated, asyncHandler(async (req, res) => {
    const reservedTables = await Tables.find({ status: 'reserved' }).populate('reservedBy');
    const vacantTables = await Tables.find({ status: 'vacant' });

    // Ensure reservedBy is not null before accessing its properties
    const reservedTablesWithUsers = reservedTables.map(table => ({
        ...table.toObject(),
        reservedBy: table.reservedBy || { name: 'Unknown', _id: 'Unknown' }
    }));

    res.render(res.locals.isAdmin ? 'tables/adminTables' : 'tables/customerTables', {
        reservedTables: reservedTablesWithUsers,
        vacantTables
    });
}));

app.post('/customer/tables/reserve', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { tableNumber } = req.body;

    if (!tableNumber) {
        setFlash(req, 'error_msg', 'Table number is required');
        return res.redirect('/tables');
    }

    try {
        const table = await Tables.findOne({ tableNumber });
        if (!table) {
            setFlash(req, 'error_msg', 'Table not found');
            return res.redirect('/tables');
        }
        if (table.status !== 'vacant') {
            setFlash(req, 'error_msg', 'Table is not available');
            return res.redirect('/tables');
        }

        // Check if the user already has a reserved table
        const userHasReservation = await Tables.findOne({ reservedBy: req.session.user._id, status: 'reserved' });
        if (userHasReservation) {
            setFlash(req, 'error_msg', 'You already have a reserved table');
            return res.redirect('/tables');
        }

        // Reserve the table
        table.status = 'reserved';
        table.reservedBy = req.session.user._id;
        await table.save();
        io.emit('tableStatusChanged', { tableNumber: table.tableNumber, status: table.status });

        setFlash(req, 'success_msg', 'Table reserved successfully');
    } catch (err) {
        console.error('Error reserving table:', err);
        setFlash(req, 'error_msg', 'An error occurred while reserving the table');
    }

    return res.redirect('/tables');
}));

app.post('/customer/tables/cancel', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { tableNumber } = req.body;

    if (!tableNumber) {
        setFlash(req, 'error_msg', 'Table number is required');
        return res.redirect('/tables');
    }

    try {
        const table = await Tables.findOne({ tableNumber, reservedBy: req.session.user._id, status: 'reserved' });
        if (!table) {
            setFlash(req, 'error_msg', 'Table not found or not reserved by you');
            return res.redirect('/tables');
        }

        // Cancel the reservation
        table.status = 'vacant';
        table.reservedBy = null;
        await table.save();
        io.emit('tableStatusChanged', { tableNumber: table.tableNumber, status: table.status });

        setFlash(req, 'success_msg', 'Table reservation canceled successfully');
    } catch (err) {
        console.error('Error canceling table reservation:', err);
        setFlash(req, 'error_msg', 'An error occurred while canceling the table reservation');
    }

    return res.redirect('/tables');
}));

app.get('/tables/availability', ensureAuthenticated, asyncHandler(async (req, res) => {
    const tables = await Tables.find();
    res.json(tables);
}));

// Global error-handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    if (req.xhr || req.headers.accept.includes('json')) {
        res.status(500).json({ error: 'Something went wrong!' });
    } else {
        req.flash('error_msg', 'An unexpected error occurred');
        res.status(500).redirect('/');
    }
});

// Starting the server
server.listen(3000, () => console.log('Server is running on port 3000'));