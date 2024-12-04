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
const moment = require('moment'); // Import moment.js

const publishableKey = "pk_test_51Q3z7BC43VQjRgwcUBGg4jE6p8fIgV2bPm3UaIcToGtD0iv63X1E8C6DWdopnBreXLzYRyOgGA2OmuPK3TD5kDKq00OnPi8IFb"
const SceretKey = "sk_test_51Q3z7BC43VQjRgwcAs49iBHc2K9TjsknC1c82sHQrIcuDBiSlsrqX1hVhrJxrKwpSwwkqt9RzqX15xRnrPlbMMA100lrBmFDXs"
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
    mongoose.connect('mongodb://localhost:27017/UpdatedCafe', )
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

async function consolidateOrdersForReservation(tableNumber) {
    try {
        // Find all pending, preparing, or served orders for the table
        const orders = await Orders.find({
            tableNumber,
            status: { $in: ['pending', 'preparing', 'served'] } // Ensuring we only fetch relevant orders
        }).populate('items.menuItem'); // Ensure we populate the menu items

        if (!orders.length) {
            console.error(`No orders found for table number: ${tableNumber}`);
            return null; // Or handle this case as needed
        }

        const consolidatedOrder = {
            items: [],
            total: 0,
            tableNumber: tableNumber,
            customer: orders[0].customer, // Assuming all orders are from the same customer
        };

        // Combine all items from each order and sum up the total cost
        orders.forEach(order => {
            order.items.forEach(item => {
                consolidatedOrder.items.push({
                    menuItem: item.menuItem, // Ensure the item has a valid menuItem reference
                    quantity: item.quantity,
                });

                // Calculate total for each item
                if (item.menuItem && item.menuItem.price) {
                    consolidatedOrder.total += item.menuItem.price * item.quantity;
                } else {
                    console.error(`Invalid menu item or price for order item: ${item._id}`);
                }
            });
        });

        return consolidatedOrder;
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
    if (!Menu.isValidId(id)) {
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
    if (!Menu.isValidId(id)) {
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
    if (!Menu.isValidId(id)) {
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
    if (!Menu.isValidId(id)) {
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
    if (!Menu.isValidId(id)) {
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
    const orders = await Orders.find().populate('items.menuItem').populate('customer');
    res.render('orders/adminOrders', { 
        orders,
        title: 'Admin Orders',
        currentUser: req.session.user,
        isAdmin: true
    });
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
    if (!OrderHistory.isValidId(id)) {
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

app.get('/admin/orders/:id', ensureAuthenticated, ensureAdmin, asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId first
        if (!OrderHistory.isValidId(id)) {
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

        res.render('orders/orderDetails', { 
            order,
            title: 'Order Details',
            currentUser: req.session.user,
            isAdmin: true
        });
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

    // Validate ObjectId first
    if (!Orders.isValidId(id)) {
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
    
    // Validate ObjectId first
    if (!Orders.isValidId(id)) {
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
    if (!Orders.isValidId(id)) {
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
    if (!Orders.isValidId(id)) {
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
        if (!Receipt.isValidId(id)) {
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
            .populate('orders')
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
}))

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
        if (!Users.isValidId(id)) {
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
        if (!Users.isValidId(id)) {
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
    if (!Users.isValidId(id)) {
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
    res.redirect('/tables');
});

app.get('/tables/:id/edit', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!Tables.isValidId(id)) {
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
    if (!Tables.isValidId(id)) {
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
    return res.redirect('/tables');
}));

app.get('/tables/:id/delete', ensureAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    // Validate ObjectId first
    if (!Tables.isValidId(id)) {
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
    return res.redirect('/tables');
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
    const { tableNumber, total } = req.body;
    const cart = req.session.cart || [];

    console.log('Placing order:', { tableNumber, total, cart });

    // Validate fields
    if (!cart.length || !tableNumber || !total) {
        console.log('Validation failed: All fields are required');
        req.flash('error_msg', 'All fields are required');
        return res.redirect('/cart/view');
    }

    const items = cart.map(item => ({
        menuItem: item.menuItemId,
        quantity: item.quantity
    }));

    console.log('Order items:', items);

    try {
        const newOrder = new Orders({ items, tableNumber, total, customer: req.session.user._id });
        await newOrder.save();
        console.log('New Order ID:', newOrder._id); // Log the order ID after saving


        // Update user with the new order
        await Users.findByIdAndUpdate(req.session.user._id, { $push: { orders: newOrder._id } });

        // Clear the cart after placing the order
        req.session.cart = [];
        console.log('Order placed successfully:', newOrder);

        req.flash('success_msg', 'Order placed successfully');
        return res.redirect('/customer/orders/' + newOrder._id);
    } catch (err) {
        console.error('Error saving new order:', err);
        req.flash('error_msg', 'Failed to place the order');
        return res.redirect('/cart/view');
    }
}));

// Route to cancel an order
app.post('/orders/cancel/:id', ensureAuthenticated, ensureTableReserved, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error_msg', 'Invalid order ID.');
        return res.redirect('/customer/orders');
    }

    try {
        const order = await Orders.findById(id);

        if (!order) {
            req.flash('error_msg', 'Order not found');
            return res.redirect('/customer/orders');
        }

        if (['ready', 'served'].includes(order.status)) {
            req.flash('error_msg', 'Orders that are ready or served cannot be cancelled');
            return res.redirect('/customer/orders');
        }

        order.status = 'cancelled';
        await order.save();
        req.flash('success_msg', 'Order cancelled successfully');
        return res.redirect('/customer/orders');
    } catch (err) {
        console.error('Error cancelling order:', err);
        req.flash('error_msg', 'Failed to cancel the order');
        return res.redirect('/customer/orders');
    }
}));

// Route to get customer orders
app.get('/customer/orders', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const userId = req.session.user._id;

        // Find the reserved table for the customer
        const reservedTable = await Tables.findOne({ reservedBy: userId, status: 'reserved' });

        if (!reservedTable) {
            req.flash('error_msg', 'No reserved table found.');
            return res.redirect('/tables');
        }

        console.log('Reserved Table:', reservedTable);

        // Fetch orders placed for this reserved table by the customer
        const orders = await Orders.find({
                customer: userId,
                tableNumber: reservedTable.tableNumber,  // Match table number of the reserved table
                status: { $nin: ['completed', 'cancelled'] },  // Fetch only orders that are not completed
                placedAt: { $gte: reservedTable.reservationStartTime }  // Orders placed after the table was reserved
            })
            .populate('items.menuItem')  // Populate menu item details
            .populate('customer');  // Populate customer details

        console.log('Orders:', orders);

        // if (!orders || orders.length === 0) {
        //     req.flash('info_msg', 'You have no active orders at the moment.');
        //     return res.redirect('/customer/menu');
        // }

        // Render the customer's orders
        res.render('orders/customerOrders', {
            orders,
            tableNumber: reservedTable.tableNumber,  // Pass table number for display purposes
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

// Route to get the receipt details
app.get('/customer/receipt/:id', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { id } = req.params;

    try {
        // Find the receipt by ID and populate the related fields
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

        // Check if receipt was found
        if (!receipt) {
            setFlash(req, 'error_msg', 'Receipt not found');
            return res.redirect('/customer/orders');
        }

        // Log receipt for debugging
        console.log('Receipt found:', receipt);

        // Render the receipt view with the retrieved data
        res.render('orders/receipt', { 
            receipt,
            title: 'Receipt',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (error) {
        console.error('Error fetching receipt:', error);
        setFlash(req, 'error_msg', 'An error occurred while fetching the receipt. Please try again.');
        return res.redirect('/customer/orders');
    }
}));

// Route to handle payment
app.post('/customer/orders/:tableNumber/pay', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const { tableNumber } = req.params;

        const orders = await Orders.find({ tableNumber, customer: req.session.user._id, status: { $ne: 'completed' } });

        const allServed = orders.every(order => order.status === 'served');
        if (!allServed) {
            req.flash('error_msg', 'All orders must be served before payment.');
            return res.redirect('/customer/orders');
        }

        // Process payment if all orders are served
        const consolidatedOrder = await consolidateOrdersForReservation(tableNumber);
        if (!consolidatedOrder || !consolidatedOrder.items || consolidatedOrder.items.length === 0) {
            req.flash('error_msg', 'No valid orders found for this reservation.');
            return res.redirect('/customer/orders');
        }

        // Calculate total if consolidated order is found
        consolidatedOrder.total = consolidatedOrder.items.reduce((total, item) => {
            return total + (item.menuItem.price * item.quantity);
        }, 0);

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
            const consolidatedOrder = await consolidateOrdersForReservation(tableNumber);

            if (!consolidatedOrder || !consolidatedOrder.items || consolidatedOrder.items.length === 0) {
                req.flash('error_msg', 'No valid orders found for this reservation.');
                return res.redirect('/customer/orders');
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

            // Create a new payment entry in PaymentHistory
            const paymentHistory = new Payment({
                customer: req.session.user._id,
                tableNumber,
                orders: orders.map(order => order._id),
                totalAmount,
                paymentStatus: 'paid',
                paymentMethod: 'card',
            });

            await paymentHistory.save();
            console.log("Payment history saved:", paymentHistory);

            // Save order history
            const completedOrders = await Orders.find({ tableNumber, customer: req.session.user._id });
            const orderHistory = new OrderHistory({
                items: completedOrders.map(order => order.items).flat(),
                tableNumber,
                total: totalAmount,
                customer: req.session.user._id,
                status: 'completed'
            });

            await orderHistory.save();
            console.log("Order history saved:", orderHistory);

            // Mark the table as vacant
            const table = await Tables.findOne({ tableNumber, status: 'reserved' });

            if (table) {
                table.status = 'vacant';  // Mark the table as unreserved
                table.reservedBy = null;  // Clear the reservation
                await table.save();
            }
            console.log("Table marked as vacant.");

            // Generate and save a receipt
            const receipt = new Receipt({
                customer: req.session.user._id,
                paymentId: paymentHistory._id,  // Link the payment ID
                tableNumber,
                orders: orders.map(order => order._id),  // Link related orders
                totalAmount,
                taxAmount: totalAmount * 0.1,  // 10% tax
                serviceCharge: totalAmount * 0.05,  // 5% service charge
                paymentMethod: 'card',
            });

            await receipt.save();
            console.log("Receipt saved:", receipt);

            // Update orders to link the receipt after it's saved
            await Orders.updateMany(
                { tableNumber, customer: req.session.user._id },
                { receipt: receipt._id }  // Link the receipt ID to the orders
            );
            console.log("Orders updated with receipt link.");

            req.flash('success_msg', 'Payment successful and receipt generated.');
            return res.redirect('/customer/orders');
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

// Profile Management
app.get('/user/profile', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        // Fetch the user, along with orders and payment history
        const user = await Users.findById(req.session.user._id)
            .populate({
                path: 'orders',
                populate: [
                    { path: 'items.menuItem' },  // Populate menu items in the orders
                    { path: 'receipt', model: 'Receipt' }  // Populate receipts linked to the orders
                ]
            })
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

        // Separate current and previous orders
        const currentOrders = await Orders.find({
            customer: req.session.user._id,
            status: { $in: ['pending', 'preparing', 'served'] }
        }).populate('items.menuItem');
        
        const previousOrders = await Orders.find({
            customer: req.session.user._id,
            status: { $in: ['completed', 'cancelled'] }  // Fixed spelling of 'cancelled'
        }).populate('items.menuItem');

        // Fetch receipts related to this user
        const receipts = await Receipt.find({ customer: req.session.user._id })
            .populate('orders')
            .populate('paymentId');

        // Fetch payments made by this user
        const payments = await Payment.find({ customer: req.session.user._id })
            .populate('orders')
            .populate('receipt');

        // Debugging logs for current orders and payments
        console.log('Current orders:', currentOrders);
        console.log('Payments:', payments);

        // Render the profile page with the user data, orders, receipts, and payments
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

app.post('/user/profile', ensureAuthenticated, asyncHandler(async (req, res) => {
    const { firstName, lastName, email, mobile } = req.body;
    await Users.findByIdAndUpdate(req.session.user._id, { firstName, lastName, email, mobile });
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

        // Fetch reserved and vacant tables
        const reservedTables = await Tables.find({ status: 'reserved' }).populate('reservedBy');
        const vacantTables = await Tables.find({ status: 'vacant' });

        // Fetch the reserved table for the current user
        const reservedTable = await Tables.findOne({ reservedBy: userId, status: 'reserved' });

        // If the user has a reserved table, fetch the orders placed for that table
        const userOrders = reservedTable ? await Orders.find({
            customer: userId,
            tableNumber: reservedTable.tableNumber,  // Match the table number of the reserved table
            status: { $nin: ['completed', 'cancelled'] },  // Fetch only non-completed orders
            placedAt: { $gte: reservedTable.reservationStartTime }  // Only fetch orders placed after the reservation start time
        }) : [];

        console.log('Reserved tables:', reservedTables);

        // Ensure reservedBy is not null before accessing its properties
        const reservedTablesWithUsers = reservedTables.map(table => {
            const hasOrders = userOrders.some(order => order.tableNumber === table.tableNumber);
            return {
                ...table.toObject(),
                reservedBy: table.reservedBy || { name: 'Unknown', _id: 'Unknown' },
                hasOrders // Add a flag indicating whether the current user has placed orders for this table
            };
        });

        // Pass reserved tables, vacant tables, and user orders to the view
        res.render(res.locals.isAdmin ? 'tables/adminTables' : 'tables/customerTables', {
            reservedTables: reservedTablesWithUsers,
            vacantTables,
            orders: userOrders, // Pass user's orders for order cancellation logic
            title: 'Tables',
            currentUser: req.session.user,
            isAdmin: false
        });
    } catch (error) {
        console.error('Error fetching tables:', error);
        req.flash('error_msg', 'An error occurred while fetching tables');
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

app.get('/orderHistory', ensureAuthenticated, asyncHandler(async (req, res) => {
    try {
        const orders = await Orders.find({ user: req.session.user._id }).populate('items.menuItem');
        res.render('orders/adminOrderHistory', { orders, currentUser: req.session.user });
    } catch (error) {
        console.error('Error fetching orders:', error);
        req.flash('error_msg', 'Failed to retrieve orders');
        res.redirect('/admin');
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
