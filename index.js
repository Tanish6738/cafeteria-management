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
const moment = require('moment'); // Import moment.js
const dotenv = require('dotenv');
dotenv.config();
const publishableKey = process.env.PUBLISHABLE_KEY;
const SceretKey = process.env.SECRET_KEY;
const stripe = require('stripe')(SceretKey);

// Models
const Users = require('./models/Users');
const Menu = require('./models/Menu');
const Orders = require('./models/Orders');
const Tables = require('./models/Table');
const OrderHistory = require('./models/OrderHistory');
const Payment = require('./models/Payment');
const Receipt = require('./models/Receipt');

// Connect to MongoDB with retry mechanism
const connectWithRetry = () => {
    mongoose.connect(process.env.MONGODB_URI)
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

// Session middleware setup
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

// Flash messages middleware
app.use(flash());

// Global variables middleware
app.use((req, res, next) => {
    res.locals.messages = {
        success: req.flash('success_msg'),
        error: req.flash('error_msg'),
        info: req.flash('info_msg')
    };
    res.locals.user = req.session.user || null;
    next();
});

// Set view engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

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

async function consolidateOrdersForReservation(req, tableNumber) {
    try {
        console.log(`Fetching orders for tableNumber: ${tableNumber}`);
        console.log('Session User:', req.session.user);

        // Find all pending, preparing, or served orders for the table
        const orders = await Orders.find({
            tableNumber,
            status: { $in: ['pending', 'preparing', 'served'] }
        }).populate('items.menuItem');

        console.log(`Orders fetched for table ${tableNumber}:`, orders);

        if (!orders.length) {
            console.error(`No orders found for table number: ${tableNumber}`);
            req.flash('error_msg', 'No active orders found for this table.');
            return null; // Or handle this case as needed
        }

        // Ensure all necessary fields are populated
        const consolidatedOrder = {
            items: orders.flatMap(order => order.items.map(item => ({
                menuItem: item.menuItem,
                quantity: item.quantity,
                price: item.menuItem.price // Ensure price is populated
            }))),
            totalAmount: orders.reduce((sum, order) => sum + order.totalAmount, 0),
            orderType: 'dine-in', // Set order type
            customer: req.session.user._id, // Set customer ID
            tableNumber: tableNumber
        };

        // Save the consolidated order
        let savedConsolidatedOrder = new Orders(consolidatedOrder);
        await savedConsolidatedOrder.save();

        return savedConsolidatedOrder;
    } catch (error) {
        console.error(`Error consolidating orders for table ${tableNumber}:`, error);
        throw error; // Optionally, rethrow the error to handle it in the calling function
    }
}

// Home Route
app.get('/', async (req, res) => {
    const { user } = req.session;
    try {
        const menuItems = await Menu.find();
        setFlash(req, 'success_msg', 'Welcome to the Cafe');
        if (user && user.role === 'admin') {
            res.render('home', { menuItems, currentUser: user });
        } else {
            res.render('home', { menuItems, currentUser: user });
        }
    } catch (err) {
        console.error('Error fetching menu items:', err);
        setFlash(req, 'error_msg', 'An error occurred while fetching menu items');
        res.redirect('/login');
    }
});

// Authentication
app.get('/login', (req, res) => {
    res.render('auth/login', {
        messages: {
            error: req.flash('error_msg'),
            success: req.flash('success_msg')
        },
        currentUser: req.session.user
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/register', (req, res) => {
    res.render('auth/register', { 
        messages: {
            error: req.flash('error_msg'),
            success: req.flash('success_msg')
        },
        currentUser: req.session.user
    });
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
    console.log('Registration request received:', req.body);
    const { email, password, confirmPassword, mobile, firstName, lastName } = req.body;
    if (!firstName || !lastName || !email || !password || !confirmPassword || !mobile) {
        console.log('Registration failed: Missing fields');
        setFlash(req, 'error_msg', 'All fields are required');
        return res.redirect('/register');
    }
    if (password !== confirmPassword) {
        console.log('Registration failed: Passwords do not match');
        setFlash(req, 'error_msg', 'Passwords do not match');
        return res.redirect('/register');
    }
    if (!/^\d{10}$/.test(mobile)) {
        console.log('Registration failed: Invalid mobile number');
        setFlash(req, 'error_msg', 'Mobile number must be 10 digits');
        return res.redirect('/register');
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 15);
        const newUser = new Users({ email, password: hashedPassword, mobile, firstName, lastName });
        await newUser.save();

        // Log the user in
        req.session.user = newUser;

        // Redirect to the menu page
        console.log('Registration successful:', newUser);
        setFlash(req, 'success_msg', 'Registration successful! Redirecting to the menu...');
        return res.redirect('/customer/menu');
    } catch (error) {
        console.error('Registration error:', error);
        // Handle errors like duplicate email
        if (error.code === 11000) {
            setFlash(req, 'error_msg', 'Email is already registered');
        } else {
            setFlash(req, 'error_msg', 'Registration failed');
        }
        return res.redirect('/register');
    }
}));

// Admin Routes and Features

// Admin Menu Management
app.get('/admin/menu', ensureAuthenticated, asyncHandler(async (req, res) => {
    const menuItems = await Menu.find();
    res.render('menu/adminMenu', { 
        menuItems,
        title: 'Admin Menu',
        currentUser: req.session.user,
        isAdmin: true
    });
}));

// GET route to render the Add Menu Item form
app.get('/admin/menu/addMenuItem', ensureAdmin, (req, res) => { 
    try {
        res.render('menu/addMenuItem', {
            title: 'Add Menu Item',
            currentUser: req.session.user,
            isAdmin: true
        });
    } catch (error) {
        console.error('Error rendering add menu item form:', error);
        req.flash('error_msg', 'Failed to load add menu item form.');
        res.redirect('/admin/menu');
    }
});

app.post('/admin/menu/addMenuItem', ensureAdmin, upload.single('image'), asyncHandler(async (req, res) => {
        console.log('Received data:', req.body);
        const { name, price, description, category, available, stock } = req.body;

        // Check if all required fields are present
        if (!name || !price || !description || !category || !available || !stock) {
            setFlash(req, 'error_msg', 'All fields are required');
            return res.redirect('/admin/menu/addMenuItem');
        }

        // Validate price and stock are numbers
        if (isNaN(price) || isNaN(stock)) {
            setFlash(req, 'error_msg', 'Price and Stock must be valid numbers');
            return res.redirect('/admin/menu/addMenuItem');
        }

        // Ensure the file upload is an image (optional, but recommended)
        const allowedFileTypes = ['image/jpeg', 'image/png', 'image/gif'];
        const image = req.file ? req.file : null;
        if (image && !allowedFileTypes.includes(req.file.mimetype)) {
            setFlash(req, 'error_msg', 'Invalid image type. Only JPEG, PNG, and GIF are allowed.');
            return res.redirect('/admin/menu/addMenuItem');
        }

        const imagePath = image ? path.relative(path.join(__dirname, 'public'), req.file.path) : '';
        
        try {
            const newMenuItem = new Menu({
                name,
                price: parseFloat(price), // convert price to number
                description,
                image: imagePath,
                category,
                available: available === 'true', // convert to boolean
                stock: parseInt(stock) // convert stock to integer
            });

            console.log('New menu item:', newMenuItem);

            await newMenuItem.save();

            setFlash(req, 'success_msg', 'Menu item added successfully');
            return res.redirect('/admin/menu');
        } catch (err) {
            console.error(err);
            setFlash(req, 'error_msg', 'An error occurred while adding the menu item');
            return res.redirect('/admin/menu/addMenuItem');
        }
}));

app.get('/admin/menu/:id/edit', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid menu item ID');
        return res.redirect('/admin/menu');
    }

    const menuItem = await Menu.findById(id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/admin/menu');
    }
    res.render('menu/editMenuItem', { 
        menuItem,
        title: 'Edit Menu Item',
        currentUser: req.session.user,
        isAdmin: true
    });
}));

app.post('/admin/menu/:id/edit', ensureAdmin, upload.single('image'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, price, description, category, available, stock } = req.body;
    let image = req.file ? `/uploads/${req.file.filename}` : undefined;

    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid menu item ID');
        return res.redirect('/admin/menu');
    }

    // If no new image is uploaded, keep the existing one
    if (!image) {
        const existingMenuItem = await Menu.findById(id);
        if (!existingMenuItem) {
            setFlash(req, 'error_msg', 'Menu item not found');
            return res.redirect('/admin/menu');
        }
        image = existingMenuItem.image;
    }

    await Menu.findByIdAndUpdate(id, { name, price, description, image, category, available, stock });
    setFlash(req, 'success_msg', 'Menu item updated successfully');
    return res.redirect('/admin/menu');
}));

app.get('/menu/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid menu item ID');
        return res.redirect('/menu');
    }

    const menuItem = await Menu.findById(id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/menu');
    }
    res.render('menu/menuItem', { 
        menuItem,
        title: 'Menu Item',
        currentUser: req.session.user,
        isAdmin: req.session.user?.role === 'admin'
    });
}));

app.get('/admin/menu/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid menu item ID');
        return res.redirect('/admin/menu');
    }

    const menuItem = await Menu.findById(id);
    if (!menuItem) {
        setFlash(req, 'error_msg', 'Menu item not found');
        return res.redirect('/admin/menu');
    }

    // Delete the menu item
    await Menu.findByIdAndDelete(id);
    setFlash(req, 'success_msg', 'Menu item deleted successfully');
    res.redirect('/admin/menu');
}));

app.post('/admin/menu/:id/toggle-availability', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid menu item ID');
        return res.redirect('/admin/menu');
    }

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
    try {
        // Fetch all orders and populate customer details
        const orders = await Orders.find({})
            .populate({
                path: 'customer',
                select: 'firstName lastName email'  // Select the fields we need
            })
            .lean();

        console.log('Admin Orders:', orders);  // Debug log

        res.render('orders/adminOrders', {
            orders,
            title: 'Admin Orders',
            currentUser: req.session.user,
            isAdmin: true
        });
    } catch (error) {
        console.error('Error fetching admin orders:', error);
        req.flash('error_msg', 'Error fetching orders');
        res.redirect('/admin');
    }
}));

app.get('/admin/orders/history', ensureAdmin, asyncHandler(async (req, res) => {
    try {
        // Fetch all completed orders from OrderHistory
        const ordersHistory = await OrderHistory.find()
            .populate('items.menuItem')  // Populate menuItem in the items array
            .populate('customer')  // Populate the customer details
            .populate('receipt')  // Populate the receipt details
            .lean(); // Use lean() for faster Mongoose queries and to work with plain JavaScript objects

        // Render the admin order history page with the fetched ordersHistory
        res.render('orders/adminOrderHistory', { 
            orders: ordersHistory,
            title: 'Admin Order History',
            currentUser: req.session.user,
            isAdmin: true
        });
    } catch (error) {
        console.error('Error fetching order history:', error);
        req.flash('error_msg', 'Failed to load order history.');
        res.redirect('/admin/dashboard'); // Redirect to an appropriate page
    }
}));

app.get('/admin/orders/:id/receipt', ensureAdmin, asyncHandler(async (req, res) => {

    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid order ID');
        return res.redirect('/admin/orders/history');
    }

    const order = await OrderHistory.findById(id)
        .populate('items.menuItem')
        .populate('customer')
        .lean();

    if (!order) {
        setFlash(req, 'error_msg', 'Order not found');
        return res.redirect('/admin/orders/history');
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

    res.render('orders/receipt', { 
        order,
        title: 'Order Receipt',
        currentUser: req.session.user,
        isAdmin: true
    });
}));

app.get('/admin/orders/:id', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;

    try {
        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            setFlash(req, 'error_msg', 'Invalid order ID');
            return res.redirect('/admin/orders');
        }

        // Fetch the order with populated data
        const order = await Orders.findById(id)
            .populate('customer')
            .populate('items.menuItem')
            .lean();

        if (!order) {
            setFlash(req, 'error_msg', 'Order not found');
            return res.redirect('/admin/orders');
        }

        // Fetch table data if table number exists
        let table = null;
        if (order.tableNumber) {
            table = await Tables.findOne({ tableNumber: order.tableNumber }).lean();
        }

        // Fetch order history
        const orderHistory = await OrderHistory.find({ order: id })
            .sort({ timestamp: -1 })
            .populate('updatedBy', 'firstName lastName')
            .lean();

        // Calculate financial details
        const subtotal = order.items.reduce((sum, item) => sum + (item.menuItem.price * item.quantity), 0);
        const tax = subtotal * 0.10; // 10% tax
        const serviceCharge = subtotal * 0.05; // 5% service charge
        const total = subtotal + tax + serviceCharge;

        res.render('orders/orderDetails', {
            title: 'Order Details',
            order,
            orderHistory,
            table, // Pass table data to the template
            financials: {
                subtotal,
                tax,
                serviceCharge,
                total
            },
            isAdmin: true
        });
    } catch (error) {
        console.error('Error fetching order details:', error);
        setFlash(req, 'error_msg', 'Error fetching order details');
        res.redirect('/admin/orders');
    }
}));

app.post('/orders/:id/update-status', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;

    try {
        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            setFlash(req, 'error_msg', 'Invalid order ID');
            return res.redirect('/admin/orders');
        }

        const validStatuses = ['pending', 'preparing', 'ready', 'served', 'completed', 'cancelled'];
        if (!validStatuses.includes(status)) {
            setFlash(req, 'error_msg', 'Invalid order status');
            return res.redirect('/admin/orders');
        }

        const order = await Orders.findById(id);
        if (!order) {
            setFlash(req, 'error_msg', 'Order not found');
            return res.redirect('/admin/orders');
        }

        // Create order history entry
        await OrderHistory.create({
            order: order._id,
            status: status,
            previousStatus: order.status,
            updatedBy: req.session.user._id,
            notes: notes || `Status changed from ${order.status} to ${status}`,
            timestamp: new Date()
        });

        // Update order status
        order.status = status;
        await order.save();

        // Emit socket event for real-time update
        io.emit('orderStatusUpdate', {
            orderId: order._id,
            status: status,
            updatedAt: new Date()
        });

        setFlash(req, 'success_msg', 'Order status updated successfully');
        return res.redirect('/admin/orders');
    } catch (error) {
        console.error('Error updating order status:', error);
        setFlash(req, 'error_msg', 'An error occurred while updating the order status');
        return res.redirect('/admin/orders');
    }
}));

app.get('/admin/orders/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid order ID');
        return res.redirect('/orders');
    }

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
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid order ID');
        return res.redirect('/admin/orders');
    }

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
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid order ID');
        return res.redirect('/admin/orders');
    }

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

app.get('/admin/receipt/:id', ensureAdmin, asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId first
        if (!mongoose.Types.ObjectId.isValid(id)) {
            setFlash(req, 'error_msg', 'Invalid receipt ID');
            return res.redirect('/admin/receipt-records');
        }

        const receipt = await Receipt.findById(id)
            .populate({
                path: 'orders',
                populate: {
                    path: 'items.menuItem', // Correctly populate the nested menuItem within items
                    model: 'Menu'
                }
            })
            .populate('customer')
            .lean();

        if (!receipt) {
            setFlash(req, 'error_msg', 'Receipt not found');
            return res.redirect('/admin/receipt-records');
        }
        res.render('orders/receipt', { 
            receipt,
            title: 'Receipt',
            currentUser: req.session.user,
            isAdmin: true
        });

    } catch (error) {
        console.error('Error fetching receipt:', error);
        setFlash(req, 'error_msg', 'An error occurred while fetching the receipt. Please try again.');
        return res.redirect('/admin/receipt-records');
    }
}));

app.get('/admin/receipt-records', ensureAdmin, asyncHandler(async (req, res) => {
    try {
        const receipts = await Receipt.find()
            .populate('order') // Change 'orders' to 'order' to match the schema
            .populate('customer')
            .lean();

        res.render('admin/receipt-record', { 
            receipts,
            title: 'Receipt Records',
            currentUser: req.session.user,
            isAdmin: true
        });
    } catch (error) {
        console.error('Error fetching receipt records:', error);
        setFlash(req, 'error_msg', 'Failed to load receipt records.');
        return res.redirect('/admin');
    }
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
    res.render('admin/adminUsers', { 
        users: usersWithOrderInfo,
        title: 'Admin Users',
        currentUser: req.session.user,
        isAdmin: true
    });
}));

app.get('/admin/users/:id', ensureAdmin, asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        // Validate ObjectId first
        if (!mongoose.Types.ObjectId.isValid(id)) {
            setFlash(req, 'error_msg', 'Invalid user ID');
            return res.redirect('/admin/users');
        }
        const user = await Users.findById(id);

        if (!user) {
            setFlash(req, 'error_msg', 'User not found');
            return res.redirect('/admin/users');
        }

        // Generate username from first and last name
        user.username = `${user.firstName}_${user.lastName}`;

        // Fetch orders separately to handle potential errors
        let orders = [];
        try {
            orders = await Orders.find({ customer: user._id })
                .populate('items.menuItem')
                .sort({ createdAt: -1 })
                .lean();
        } catch (orderError) {
            console.error('Error fetching orders:', orderError);
        }

        // Fetch receipts separately
        let receipts = [];
        try {
            receipts = await Receipt.find({ customer: user._id })
                .sort({ createdAt: -1 })
                .lean();
        } catch (receiptError) {
            console.error('Error fetching receipts:', receiptError);
        }

        // Calculate user statistics
        const stats = {
            totalOrders: orders.length,
            totalSpent: orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0),
            averageOrderValue: orders.length ? (orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0) / orders.length) : 0,
            lastOrderDate: orders.length ? moment(orders[0].createdAt).format('MMMM Do YYYY, h:mm:ss a') : 'No orders yet'
        };

        res.render('admin/adminUserDetails', {
            user: user.toObject(),
            orders,
            receipts,
            stats,
            title: 'User Details',
            currentUser: req.session.user,
            isAdmin: true
        });
    } catch (error) {
        console.error('Error in user details route:', error);
        setFlash(req, 'error_msg', 'Error fetching user details. Please try again.');
        res.redirect('/admin/users');
    }
}));

app.delete('/admin/user/:id', ensureAdmin, asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId first
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        const user = await Users.findById(id);
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Prevent deleting the last admin
        if (user.role === 'admin') {
            const adminCount = await Users.countDocuments({ role: 'admin' });
            if (adminCount <= 1) {
                return res.status(400).json({ message: 'Cannot delete the last admin user' });
            }
        }

        // Delete associated data
        try {
            await Promise.all([
                Orders.deleteMany({ customer: user._id }),
                Receipt.deleteMany({ customer: user._id }),
                Payment.deleteMany({ customer: user._id })
            ]);
        } catch (cleanupError) {
            console.error('Error cleaning up user data:', cleanupError);
            // Continue with user deletion even if cleanup fails
        }

        await Users.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Error deleting user. Please try again.' });
    }
}));

app.get('/admin/users/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid user ID');
        return res.redirect('/admin/users');
    }

    await Users.findByIdAndDelete(id);
    setFlash(req, 'success_msg', 'User deleted successfully');
    return res.redirect('/admin/users');
}));

// Admin Table Management
app.get('/admin/tables/tableHistory', ensureAuthenticated, ensureAdmin, asyncHandler(async (req, res) => {
    try {
        // Fetch order history data
        const history = await OrderHistory.find({})
            .populate('order', 'orderNumber') // Assuming 'orderNumber' is a field in Orders
            .populate('updatedBy', 'username');

        // Pass the title along with history to the template
        res.render('tables/tableHistory', { history, title: 'Table History', currentUser: req.session.user });
    } catch (error) {
        console.error('Error fetching table history:', error);
        res.status(500).send('Internal Server Error');
    }
}));

app.get('/tables/new', ensureAdmin, (req, res) => {
    res.render('tables/addTable', {
        title: 'Add Table',
        currentUser: req.session.user,
        isAdmin: true
    });
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
    res.redirect('/admin/tables');
});

app.get('/tables/:id/edit', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid table ID');
        return res.redirect('/tables');
    }

    const table = await Tables.findById(id);
    if (!table) {
        setFlash(req, 'error_msg', 'Table not found');
        return res.redirect('/tables');
    }
    res.render('tables/editTable', { 
        table,
        title: 'Edit Table',
        currentUser: req.session.user,
        isAdmin: true
    });
}));

app.post('/tables/:id/edit', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { tableNumber, capacity, status } = req.body;

    console.log(`Editing table with ID: ${id}`);
    console.log(`Received data:`, { tableNumber, capacity, status });

    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid table ID');
        return res.redirect(`/tables/${id}/edit`);
    }

    if (!tableNumber || !capacity || !status) {
        console.log('Validation failed: All fields are required');
        setFlash(req, 'error_msg', 'All fields are required');
        return res.redirect(`/tables/${id}/edit`);
    }

    await Tables.findByIdAndUpdate(id, { tableNumber, capacity, status });
    console.log(`Table with ID: ${id} updated successfully`);
    setFlash(req, 'success_msg', 'Table updated successfully');
    return res.redirect('/admin/tables');
}));

app.get('/tables/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!mongoose.Types.ObjectId.isValid(id)) {
        setFlash(req, 'error_msg', 'Invalid table ID');
        return res.redirect('/tables');
    }

    const table = await Tables.findById(id);
    if (!table) {
        setFlash(req, 'error_msg', 'Table not found');
        return res.redirect('/tables');
    }
    await Tables.findByIdAndDelete(id);
    setFlash(req, 'success_msg', 'Table deleted successfully');
    return res.redirect('/admin/tables');
}));

// Admin tables management route
app.get('/admin/tables', ensureAdmin, asyncHandler(async (req, res) => {
    try {
        // Fetch all tables with their current status and any active reservations
        const tables = await Tables.find({})
            .populate({
                path: 'reservedBy',
                select: 'firstName lastName email'
            })
            .populate({
                path: 'currentOrders',
                populate: [
                    {
                        path: 'customer',
                        model: 'Users',
                        select: 'firstName lastName email'
                    },
                    {
                        path: 'items.menuItem',
                        select: 'name price'
                    }
                ]
            })
            .sort({ tableNumber: 1 })
            .lean();

        // Get active orders for each table
        const tablesWithOrders = await Promise.all(tables.map(async (table) => {
            const activeOrders = await Orders.find({
                tableNumber: table.tableNumber,
                status: { $in: ['pending', 'preparing', 'ready', 'served'] }
            })
            .populate('customer', 'firstName lastName')
            .populate('items.menuItem', 'name price')
            .lean();

            return {
                ...table,
                activeOrders
            };
        }));

        res.render('tables/adminTables', {
            title: 'Table Management',
            tables: tablesWithOrders,
            messages: {
                success_msg: req.flash('success_msg'),
                error_msg: req.flash('error_msg')
            }
        });
    } catch (error) {
        console.error('Error fetching tables:', error);
        setFlash(req, 'error_msg', 'Error fetching tables');
        res.redirect('/admin/dashboard');
    }
}));

// Admin update table status
app.post('/admin/tables/:tableNumber/update', ensureAdmin, asyncHandler(async (req, res) => {
    const { tableNumber } = req.params;
    const { status, capacity } = req.body;

    try {
        const table = await Tables.findOneAndUpdate(
            { tableNumber },
            { 
                status,
                capacity: parseInt(capacity),
                lastUpdated: new Date()
            },
            { new: true }
        );

        if (!table) {
            setFlash(req, 'error_msg', 'Table not found');
            return res.redirect('/admin/tables');
        }

        setFlash(req, 'success_msg', 'Table updated successfully');
        res.redirect('/admin/tables');
    } catch (error) {
        console.error('Error updating table:', error);
        setFlash(req, 'error_msg', 'Error updating table');
        res.redirect('/admin/tables');
    }
}));

// Admin clear table
app.post('/admin/tables/:tableNumber/clear', ensureAdmin, asyncHandler(async (req, res) => {
    const { tableNumber } = req.params;

    try {
        const table = await Tables.findOne({ tableNumber });
        if (!table) {
            setFlash(req, 'error_msg', 'Table not found');
            return res.redirect('/admin/tables');
        }

        // Update all active orders for this table to completed
        await Orders.updateMany(
            { 
                tableNumber,
                status: { $in: ['pending', 'preparing', 'ready', 'served'] }
            },
            { 
                status: 'completed',
                completedAt: new Date()
            }
        );

        // Clear the table
        table.status = 'vacant';
        table.reservedBy = null;
        table.currentOrders = [];
        table.lastUpdated = new Date();
        await table.save();

        setFlash(req, 'success_msg', 'Table cleared successfully');
        res.redirect('/admin/tables');
    } catch (error) {
        console.error('Error clearing table:', error);
        setFlash(req, 'error_msg', 'Error clearing table');
        res.redirect('/admin/tables');
    }
}));

// Customer Routes and Features

// Menu Browsing
app.get('/customer/menu', ensureAuthenticated, asyncHandler(async (req, res) => {
    const menuItems = await Menu.find();
    const reservedTable = await Tables.findOne({ reservedBy: req.session.user._id, status: 'reserved' });
    const cartCount = req.session.cart ? req.session.cart.length : 0; // Calculate cart count
    res.render('menu/customerMenu', { 
        menuItems,
        reservedTable,
        title: 'Customer Menu',
        currentUser: req.session.user,
        isAdmin: false,
        cartCount // Pass cartCount to the template
    });
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
        return res.json({ success: false, message: 'Menu item and quantity are required' });
    }

    const cart = req.session.cart || [];
    const itemIndex = cart.findIndex(item => item.menuItemId === menuItemId);

    // Fetch the price of the menu item from the database
    const menuItem = await Menu.findById(menuItemId);
    if (!menuItem) {
        console.log('Menu item not found');
        return res.json({ success: false, message: 'Menu item not found' });
    }

    if (itemIndex > -1) {
        if (quantity > 0) {
            console.log(`Updating quantity of item ${menuItemId} to ${quantity}`);
            cart[itemIndex].quantity = quantity;
        } else {
            console.log(`Removing item ${menuItemId} from cart`);
            cart.splice(itemIndex, 1);
        }
    } else {
        if (quantity > 0) {
            console.log(`Adding new item ${menuItemId} to cart with quantity ${quantity}`);
            cart.push({ menuItemId, quantity, price: menuItem.price });
        }
    }

    req.session.cart = cart;
    console.log('Cart updated:', cart);
    return res.json({ success: true, message: 'Cart updated' });
}));

app.get('/cart/view', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const cart = req.session.cart || [];
        const menuItems = await Menu.find({ _id: { $in: cart.map(item => item.menuItemId) } });
        
        // Create a properly structured cart object
        const cartData = {
            items: cart.map(item => {
                const menuItem = menuItems.find(menu => menu._id.toString() === item.menuItemId);
                return {
                    menuItem: menuItem,
                    quantity: item.quantity,
                    subtotal: menuItem ? menuItem.price * item.quantity : 0
                };
            }),
            total: 0
        };
        
        // Calculate total
        cartData.total = cartData.items.reduce((total, item) => total + item.subtotal, 0);
        
        const tableNumberJson = await Tables.findOne({ reservedBy: req.session.user._id, status: 'reserved' });
        const tableNumber = tableNumberJson ? tableNumberJson.tableNumber : null;
        
        res.render('cart/viewCart', { 
            cart: cartData,
            tableNumber,
            user: req.session.user,
            title: 'Cart',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (error) {
        console.error('Error in cart view:', error);
        req.flash('error_msg', 'Error loading cart');
        res.redirect('/menu');
    }
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

// Customer Order Placement and Management

app.post('/orders/place', ensureAuthenticated, ensureTableReserved, asyncHandler(async (req, res) => {
    const { tableNumber, total, orderType } = req.body;
    const cart = req.session.cart || [];

    console.log('Placing order:', { tableNumber, total, orderType, cart });

    if (!cart.length) {
        req.flash('error_msg', 'Your cart is empty. Please add items before placing an order.');
        return res.redirect('/cart/view');
    }

    try {
        // Fetch menu items to ensure price is correct
        const menuItems = await Menu.find({ _id: { $in: cart.map(item => item.menuItemId) } });

        const orderItems = cart.map(item => {
            const menuItem = menuItems.find(menuItem => menuItem._id.toString() === item.menuItemId);
            const price = menuItem ? parseFloat(menuItem.price) : 0;

            return {
                menuItem: new mongoose.Types.ObjectId(item.menuItemId),
                quantity: parseInt(item.quantity),
                price: price
            };
        });

        const userId = new mongoose.Types.ObjectId(req.session.user._id);
        
        // Create new order with customer field
        const newOrder = await Orders.create({
            customer: userId,  // Explicitly set customer field
            tableNumber: parseInt(tableNumber),
            items: orderItems,
            status: 'pending',
            totalAmount: parseFloat(total),
            orderType
        });

        console.log('New Order Data:', newOrder.toObject());
        
        // Verify the order was saved correctly
        const savedOrder = await Orders.findById(newOrder._id);
        console.log('Saved Order:', savedOrder);
        
        // Clear the cart after placing the order
        req.session.cart = [];
        req.flash('success_msg', 'Order placed successfully!');
        return res.redirect('/customer/orders');
    } catch (error) {
        console.error('Error placing order:', error);
        req.flash('error_msg', 'An error occurred while placing your order. Please try again.');
        return res.redirect('/cart/view');
    }
}));

app.get('/customer/orders', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.session.user._id);

        // Fetch the reserved table for the current user
        const reservedTable = await Tables.findOne({ reservedBy: userId, status: 'reserved' });

        if (!reservedTable) {
            req.flash('error_msg', 'No reserved table found.');
            return res.redirect('/tables');
        }

        // console.log('Reserved Table:', reservedTable);

        // Log query conditions for debugging
        const queryConditions = {
            customer: userId,
            tableNumber: parseInt(reservedTable.tableNumber),
            status: { $nin: ['completed', 'cancelled'] }
        };
        // console.log('Query Conditions:', queryConditions);

        // First, try to find all orders regardless of conditions
        const allOrders = await Orders.find({}).lean();
        // console.log('All Orders in DB:', allOrders);

        // Then try each condition separately
        const ordersByCustomer = await Orders.find({ customer: userId }).lean();
        // console.log('Orders by Customer:', ordersByCustomer);

        const ordersByTable = await Orders.find({ tableNumber: parseInt(reservedTable.tableNumber) }).lean();
        // console.log('Orders by Table:', ordersByTable);

        const ordersByStatus = await Orders.find({ status: { $nin: ['completed', 'cancelled'] } }).lean();
        // console.log('Orders by Status:', ordersByStatus);

        // Now try the combined query with lean() and proper population
        const orders = await Orders.find(queryConditions)
            .populate('items.menuItem')
            .populate('customer')
            .lean();

        console.log('Raw Orders from DB:', orders);

        // Handle empty results
        if (!orders || orders.length === 0) {
            console.log('No orders found for this customer.');
            return res.render('orders/customerOrders', {
                orders: [],
                tableNumber: reservedTable.tableNumber,
                title: 'Customer Orders',
                currentUser: req.session.user,
                isAdmin: false
            });
        }

        // console.log('Fetched Orders:', orders);

        res.render('orders/customerOrders', {
            orders,
            tableNumber: reservedTable.tableNumber,
            title: 'Customer Orders',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (error) {
        console.error('Error fetching customer orders:', error);
        req.flash('error_msg', 'An error occurred while fetching your orders.');
        return res.redirect('/');
    }
}));

// Route to display the receipt
app.get('/customer/orders/receipt/:receiptId', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { receiptId } = req.params;

    try {
        if (!mongoose.Types.ObjectId.isValid(receiptId)) {
            req.flash('error_msg', 'Invalid receipt ID');
            return res.redirect('/customer/orders');
        }

        const receipt = await Receipt.findById(receiptId)
            .populate('order', '_id')  // Ensure the order ID is populated
            .populate('payment', '_id')  // Ensure the payment ID is populated
            .populate('customer', 'username email')  // Populate customer details
            .lean();

        console.log('Fetched Receipt:', receipt); // Debugging

        if (!receipt) {
            req.flash('error_msg', 'Receipt not found');
            return res.redirect('/customer/orders');
        }

        // Check for missing fields and add default fallbacks
        if (!receipt.order) {
            receipt.order = { _id: 'Not available' }; // Fallback for missing order
        }

        if (!receipt.payment) {
            receipt.payment = { _id: 'Not available' }; // Fallback for missing payment
        }

        res.render('orders/receipt', { receipt });
    } catch (error) {
        console.error('Error fetching receipt:', error);
        req.flash('error_msg', 'An error occurred while fetching the receipt. Please try again.');
        return res.redirect('/customer/orders');
    }
}));

app.post('/customer/orders/:tableNumber/pay', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const { tableNumber } = req.params;

        console.log(`Processing payment for table number: ${tableNumber}`);

        const orders = await Orders.find({ tableNumber, customer: req.session.user._id, status: { $ne: 'completed' } });
        console.log(`Orders fetched for table number ${tableNumber}:`, orders);

        const allServed = orders.every(order => order.status === 'served');
        console.log(`All orders served: ${allServed}`);
        if (!allServed) {
            req.flash('error_msg', 'All orders must be served before payment.');
            return res.redirect('/customer/orders');
        }

        // Process payment if all orders are served
        const consolidatedOrder = await consolidateOrdersForReservation(req, tableNumber);
        console.log(`Consolidated order:`, consolidatedOrder);
        if (!consolidatedOrder || !consolidatedOrder.items || consolidatedOrder.items.length === 0) {
            req.flash('error_msg', 'No valid orders found for this reservation.');
            return res.redirect('/customer/orders');
        }

        // Calculate total if consolidated order is found
        consolidatedOrder.total = consolidatedOrder.items.reduce((total, item) => {
            return total + (item.menuItem.price * item.quantity);
        }, 0);
        console.log(`Total amount for consolidated order: ${consolidatedOrder.total}`);

        // Create a new payment session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: consolidatedOrder.items.map(item => ({
                price_data: {
                    currency: 'inr',
                    product_data: {
                        name: item.menuItem.name,
                    },
                    unit_amount: item.menuItem.price * 100 * item.quantity, // Convert to cents
                },
                quantity: 1,
            })),
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/customer/orders/succeed?session_id={CHECKOUT_SESSION_ID}&tableNumber=${tableNumber}`,
            cancel_url: `${req.protocol}://${req.get('host')}/customer/orders?tableNumber=${tableNumber}`,
        });
        console.log(`Stripe session created:`, session);

        // Redirect to Stripe checkout
        return res.redirect(303, session.url);
    } catch (error) {
        console.error('Error processing payment:', error);
        req.flash('error_msg', 'An error occurred while processing your payment. Please try again.');
        return res.redirect('/customer/orders');
    }
}));

// Route to handle payment success
app.get('/customer/orders/succeed', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { session_id, tableNumber } = req.query;

    try {
        // Retrieve Stripe session
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status === 'paid') {
            const orders = await Orders.find({ tableNumber, customer: req.session.user._id });

            if (!orders || orders.length === 0) {
                req.flash('error_msg', 'No orders found for this reservation.');
                return res.redirect('/customer/orders');
            }

            console.log("Orders found:", orders);

            // Consolidate orders for the table
            const consolidatedOrder = await consolidateOrdersForReservation(req, tableNumber);

            if (!consolidatedOrder || !consolidatedOrder.items || consolidatedOrder.items.length === 0) {
                req.flash('error_msg', 'No valid orders found for this reservation.');
                return res.redirect('/customer/orders');
            }

            // Save the consolidated order if not already saved
            let savedConsolidatedOrder;
            if (!consolidatedOrder._id) {
                savedConsolidatedOrder = new Orders(consolidatedOrder);
                await savedConsolidatedOrder.save();
            } else {
                savedConsolidatedOrder = consolidatedOrder;
            }

            // Calculate the total amount
            consolidatedOrder.total = consolidatedOrder.items.reduce((total, item) => {
                return total + (item.menuItem.price * item.quantity);
            }, 0);
            const totalAmount = consolidatedOrder.total;

            // Update orders: mark them as paid and completed
            await Orders.updateMany(
                { tableNumber, customer: req.session.user._id },
                {
                    isPaid: true,
                    paymentStatus: 'paid',
                    status: 'completed'
                }
            );

            // Find the table and update its status to 'vacant'
            const table = await Tables.findOne({ tableNumber: tableNumber, status: 'reserved' });
            if (table) {
                table.status = 'vacant';  // Mark the table as unreserved
                table.reservedBy = null;  // Clear the reservation
                await table.save();
            }

            // Calculate subtotal, tax, and total
            const subtotal = orders.reduce((sum, order) => sum + order.totalAmount, 0);
            const tax = subtotal * 0.1; // Assuming 10% tax rate
            const total = subtotal + tax;

            // Generate a unique receipt number
            const receiptNumber = `REC-${Date.now()}`;

            // Generate a receipt
            const paymentId = new mongoose.Types.ObjectId(); // Replace with actual payment ID if available
            const receipt = new Receipt({
                customer: req.session.user._id,
                orders: orders.map(order => order._id),
                total,
                subtotal,
                tax,
                receiptNumber,
                payment: paymentId, // Use actual payment ID
                order: savedConsolidatedOrder._id, // Use the saved order's ID
                paymentStatus: 'paid',
                paymentDate: new Date()
            });
            await receipt.save();

            // Redirect to the receipt page
            return res.redirect(`/customer/orders/receipt/${receipt._id}`);
        } else {
            req.flash('error_msg', 'Payment was not successful.');
            return res.redirect('/customer/orders');
        }
    } catch (error) {
        console.error('Error processing payment success:', error);
        req.flash('error_msg', 'An error occurred while verifying the payment. Please try again.');
        return res.redirect('/customer/orders');
    }
}));

// Route to get specific order details
app.get('/customer/orders/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { id } = req.params;

    console.log(`Fetching order details for order ID: ${id}`);

    if (!mongoose.Types.ObjectId.isValid(id)) {
        console.log('Invalid order ID:', id);
        req.flash('error_msg', 'Invalid order ID.');
        return res.redirect('/customer/orders');
    }

    try {
        const order = await Orders.findOne({ _id: id, customer: req.session.user._id })
            .populate('items.menuItem')
            .populate('customer');

        if (!order) {
            console.log('Order not found for ID:', id);
            req.flash('error_msg', 'Order not found.');
            return res.redirect('/customer/orders');
        }

        const table = await Tables.findOne({ tableNumber: order.tableNumber, status: 'reserved' });
        const receipt = await Receipt.findOne({ orders: order._id });

        console.log('Order details fetched successfully for ID:', id);
        res.render('orders/orderDetails', { 
            order,
            table,
            receipt,
            title: 'Order Details',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (error) {
        console.error('Error fetching order details for ID:', id, error);
        req.flash('error_msg', 'An error occurred while fetching order details.');
        return res.redirect('/customer/orders');
    }
}));

// Route for customer to cancel their order
app.post('/orders/cancel/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            setFlash(req, 'error_msg', 'Invalid order ID');
            return res.redirect('/customer/orders');
        }

        // Find the order and verify ownership
        const order = await Orders.findOne({
            _id: id,
            customer: req.session.user._id,
            status: { $nin: ['served', 'completed', 'cancelled'] }
        });

        if (!order) {
            setFlash(req, 'error_msg', 'Order not found or cannot be cancelled');
            return res.redirect('/customer/orders');
        }

        // Update order status to cancelled
        order.status = 'cancelled';
        await order.save();

        // Emit socket event for real-time update
        io.emit('orderStatusUpdate', {
            orderId: order._id,
            status: 'cancelled',
            updatedAt: new Date()
        });

        setFlash(req, 'success_msg', 'Order cancelled successfully');
        return res.redirect('/customer/orders');
    } catch (error) {
        console.error('Error cancelling order:', error);
        setFlash(req, 'error_msg', 'An error occurred while cancelling the order');
        return res.redirect('/customer/orders');
    }
}));

// Profile Management
app.get('/user/profile', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        // Fetch the user with populated orders and payment history
        const user = await Users.findById(req.session.user._id)
            .populate({
                path: 'orders',
                populate: {
                    path: 'items.menuItem',
                    select: 'name price'
                }
            })
            .populate('paymentHistory');

        // Separate current and previous orders
        const currentOrders = await Orders.find({
            customer: req.session.user._id,
            status: { $in: ['pending', 'preparing', 'served'] }
        }).populate('items.menuItem');

        const previousOrders = await Orders.find({
            customer: req.session.user._id,
            status: { $in: ['completed', 'cancelled'] }
        }).populate('items.menuItem');

        // Fetch receipts and payments
        const receipts = await Receipt.find({ customer: req.session.user._id })
            .populate('order')
            .populate('payment');

        const payments = await Payment.find({ customer: req.session.user._id })
            .populate({
                path: 'receipt',
                populate: { path: 'order', model: 'Orders' }
            });

        // Debugging logs
        console.log('Current orders:', currentOrders);
        console.log('Payments:', payments);

        // Render the profile page
        res.render('users/profile', {
            user,
            currentOrders,
            previousOrders,
            receipts,
            payments,
            title: 'Profile',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (error) {
        console.error('Error fetching user profile:', error);
        req.flash('error_msg', 'An error occurred while fetching your profile.');
        return res.redirect('/');
    }
}));


app.get('/user/profile/edit', ensureAuthenticated, asyncHandler(async (req, res) => {
    const user = await Users.findById(req.session.user._id);
    res.render('users/editProfile', { 
        user,
        title: 'Edit Profile',
        currentUser: req.session.user,
        isAdmin: false
    });
}));


app.get('/user/profile/delete', ensureAuthenticated, asyncHandler(async (req, res) => {
    await Users.findByIdAndDelete(req.session.user._id);
    req.session.destroy();
    setFlash(req, 'success_msg', 'Profile deleted successfully');
    return res.redirect('/login');
}));

app.get('/user/payment-history', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        // Find the user by ID and populate payment history along with orders and receipt details
        const user = await Users.findById(req.session.user._id)
            .populate({
                path: 'paymentHistory',
                populate: [
                    {
                        path: 'orders',
                        model: 'Orders', // Ensure we populate the orders linked to the payment history
                        populate: {
                            path: 'items.menuItem', // Populate the items in each order
                            model: 'Menu'
                        }
                    },
                    {
                        path: 'receipt', // Populate the receipt linked to the payment
                        model: 'Receipt'
                    }
                ]
            });

        // Check if the user has any payment history
        if (!user.paymentHistory || user.paymentHistory.length === 0) {
            setFlash(req, 'info_msg', 'No payment history found.');
            return res.redirect('/user/profile'); // Redirect if no payment history is found
        }

        // Render the payment history page with the populated payment data
        res.render('user/paymentHistory', { 
            paymentHistory: user.paymentHistory,
            title: 'Payment History',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (err) {
        console.error('Error fetching payment history:', err);
        setFlash(req, 'error_msg', 'An error occurred while retrieving your payment history.');
        res.redirect('/user/profile');
    }
}));

// Table Reservation

app.get('/tables', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const userId = req.session.user._id;

        // Fetch the reserved table for the current user
        const userReservedTable = await Tables.findOne({ reservedBy: userId, status: 'reserved' });

        // Fetch reserved and vacant tables
        const reservedTables = await Tables.find({ status: 'reserved' }).populate('reservedBy');
        const vacantTables = await Tables.find({ status: 'vacant' });

        // If the user has a reserved table, fetch the orders placed for that table
        const userOrders = userReservedTable ? await Orders.find({
            customer: userId,
            tableNumber: userReservedTable.tableNumber,  // Match the table number of the reserved table
            status: { $nin: ['completed', 'cancelled'] },  // Fetch only non-completed orders
            placedAt: { $gte: userReservedTable.reservationStartTime }  // Only fetch orders placed after the reservation start time
        }) : [];

        res.render('tables/customerTables', {
            reservedTables,
            vacantTables,
            userReservedTable, // Pass userReservedTable to the template
            userOrders,
            title: 'Tables',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (err) {
        console.error('Error fetching tables:', err);
        setFlash(req, 'error_msg', 'An error occurred while retrieving tables.');
        res.redirect('/');
    }
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

        // Calculate the time difference
        const currentTime = new Date();
        const reservationTime = table.reservationStartTime; // Assuming table has a 'reservationTime' field
        const timeDifference = (currentTime - reservationTime) / (1000 * 60); // difference in minutes

        let cancellationFee = 0;
        let session;

        // Apply cancellation fee if reservation was made more than 30 minutes ago
        if (timeDifference > 30) {
            cancellationFee = 1000; // Example cancellation fee of $10 (Stripe uses the smallest currency unit, cents)

            // Create a Stripe Checkout Session for the cancellation fee
            session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `Table Reservation Cancellation Fee for Table #${tableNumber}`,
                        },
                        unit_amount: cancellationFee, // Amount in cents
                    },
                    quantity: 1
                }],
                mode: 'payment',
                success_url: `${req.protocol}://${req.get('host')}/customer/tables/cancel/success?session_id={CHECKOUT_SESSION_ID}&tableNumber=${tableNumber}`,
                cancel_url: `${req.protocol}://${req.get('host')}/tables`,
            });

            // Redirect to Stripe payment page
            return res.redirect(303, session.url);
        }

        // If the cancellation is within 30 minutes, allow table cancellation without fee
        table.status = 'vacant';
        table.reservedBy = null;
        await table.save();

        io.emit('tableStatusChanged', { tableNumber: table.tableNumber, status: table.status });
        setFlash(req, 'success_msg', 'Table reservation cancelled successfully with no cancellation fee.');

    } catch (err) {
        console.error('Error cancelling table reservation:', err);
        setFlash(req, 'error_msg', 'An error occurred while cancelling the table reservation');
    }

    return res.redirect('/tables');
}));

app.get('/customer/tables/cancel/success', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { session_id, tableNumber } = req.query;

    try {
        // Retrieve the Stripe session to verify the payment status
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status === 'paid') {
            // Mark the table as cancelled and vacant after successful payment
            const table = await Tables.findOne({ tableNumber, reservedBy: req.session.user._id, status: 'reserved' });
            
            if (!table) {
                setFlash(req, 'error_msg', 'Table not found or already cancelled.');
                return res.redirect('/tables');
            }

            table.status = 'vacant';
            table.reservedBy = null;
            await table.save();

            io.emit('tableStatusChanged', { tableNumber: table.tableNumber, status: table.status });
            
            setFlash(req, 'success_msg', `Table reservation for Table #${tableNumber} cancelled successfully after paying the cancellation fee.`);
            return res.redirect('/tables');
        } else {
            setFlash(req, 'error_msg', 'Payment for cancellation was not successful.');
            return res.redirect('/tables');
        }
    } catch (err) {
        console.error('Error processing cancellation success:', err);
        setFlash(req, 'error_msg', 'An error occurred while verifying the cancellation payment. Please try again.');
        return res.redirect('/tables');
    }
}));

// Route to display the reservation form
app.get('/reserve', ensureAuthenticated, async (req, res) => {
    try {
        const vacantTables = await Tables.find({ status: 'vacant' });

        // Check if there are any vacant tables
        if (!vacantTables.length) {
            setFlash(req, 'error_msg', 'No tables available for reservation at the moment.');
            return res.redirect('/tables');
        }

        // Render the table reservation page
        res.render('tables/reserveTable', {
            vacantTables,
            stripePublishableKey: publishableKey,  // Ensure the correct key is passed here
            title: 'Reserve Table',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (error) {
        console.error('Error fetching vacant tables:', error.message);
        setFlash(req, 'error_msg', 'An error occurred while fetching available tables. Please try again.');
        return res.redirect('/tables');
    }
});

// Route to handle Stripe payment and table reservation
app.post('/reserve/pay', ensureAuthenticated, async (req, res) => {
    const { tableNumber } = req.body;

    // Validate that a table number is provided
    if (!tableNumber) {
        setFlash(req, 'error_msg', 'Please select a valid table for reservation.');
        return res.redirect('/reserve');
    }

    try {
        // Fetch the table based on the provided number
        const table = await Tables.findOne({ tableNumber });

        // Check if the table exists and is available for reservation
        if (!table) {
            setFlash(req, 'error_msg', 'Selected table does not exist.');
            return res.redirect('/reserve');
        }

        if (table.status !== 'vacant') {
            setFlash(req, 'error_msg', `Table #${tableNumber} is currently unavailable. Please select a different table.`);
            return res.redirect('/reserve');
        }

        // Create a Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'inr',
                    product_data: {
                        name: `Table Reservation - Table #${tableNumber}`,
                        images: ['https://source.unsplash.com/featured/?restaurant']
                    },
                    unit_amount: 5000 // INR 50.00
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/tables/confirm-reservation/${tableNumber}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/reserve`
        });

        // Redirect to the Stripe checkout page
        res.redirect(303, session.url);
    } catch (error) {
        // Handle any errors from Stripe or database interaction
        console.error('Error creating checkout session:', error.message);
        setFlash(req, 'error_msg', 'An error occurred while processing your payment. Please try again.');
        return res.redirect('/reserve');
    }
});

// Route to confirm table reservation after successful payment
app.get('/tables/confirm-reservation/:tableNumber', ensureAuthenticated, async (req, res) => {
    const { tableNumber } = req.params;
    const sessionId = req.query.session_id;

    if (!sessionId) {
        setFlash(req, 'error_msg', 'Payment session not found. Please contact support.');
        return res.redirect('/tables');
    }

    try {
        // Retrieve the Stripe Checkout Session
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Ensure the payment was successful
        if (session.payment_status !== 'paid') {
            setFlash(req, 'error_msg', 'Payment not completed. Please try again.');
            return res.redirect('/tables');
        }

        // Fetch the table by table number
        const table = await Tables.findOne({ tableNumber });

        // Check if the table is still vacant
        if (!table || table.status !== 'vacant') {
            setFlash(req, 'error_msg', `Table #${tableNumber} is no longer available.`);
            return res.redirect('/tables');
        }

        // Update the table status and reserve it for the current user
        table.status = 'reserved';
        table.reservedBy = req.session.user._id;
        await table.save();

        // Emit an event for real-time updates if using websockets (optional)
        io.emit('tableStatusChanged', { tableNumber: table.tableNumber, status: table.status });

        // Confirm reservation and redirect user
        setFlash(req, 'success_msg', `Table #${tableNumber} has been successfully reserved!`);
        res.redirect('/tables');
    } catch (error) {
        console.error('Error confirming reservation:', error.message);
        setFlash(req, 'error_msg', 'An error occurred while confirming the reservation. Please contact support.');
        return res.redirect('/tables');
    }
});

app.get('/admin/dashboard', ensureAdmin, asyncHandler(async (req, res) => {
    try {
        // Fetch necessary data for the dashboard
        const orders = await Orders.find().populate('items.menuItem');
        const users = await Users.find();
        const tables = await Tables.find();

        // Render the admin dashboard view
        res.render('admin/dashboard', {
            title: 'Admin Dashboard',
            orders,
            users,
            tables,
            currentUser: req.session.user
        });
    } catch (error) {
        console.error('Error loading admin dashboard:', error);
        req.flash('error_msg', 'An error occurred while loading the dashboard.');
        return res.redirect('/admin');
    }
}));

app.get('/tables/with-orders', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        // Use $in operator to match multiple status values
        const orders = await Orders.find({
            status: { $in: ['completed', 'cancelled'] }
        });
        
        const tableNumbers = orders.map(order => order.tableNumber);
        const tables = await Tables.find({
            tableNumber: { $in: tableNumbers }
        });
        
        res.json(tables);
    } catch (error) {
        console.error('Error fetching tables:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}));

// Customer order history route
app.get('/customer/orders/history', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        // Fetch completed, cancelled, and paid orders for the current user
        const orders = await Orders.find({
            customer: req.session.user._id,
            status: { $in: ['completed', 'cancelled', 'paid'] }
        })
        .populate('items.menuItem')
        .populate('customer')
        .sort({ createdAt: -1 }) // Most recent orders first
        .lean();

        res.render('orders/customerOrderHistory', {
            title: 'Order History',
            orders,
            messages: {
                success_msg: req.flash('success_msg'),
                error_msg: req.flash('error_msg')
            }
        });
    } catch (error) {
        console.error('Error fetching order history:', error);
        setFlash(req, 'error_msg', 'Error fetching order history');
        res.redirect('/customer/orders');
    }
}));

app.get("*", (req, res) => {
    res.render('404', { currentUser: req.session.user });
});

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
