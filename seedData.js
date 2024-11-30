const mongoose = require('mongoose');
const Menu = require('./models/Menu');
const Table = require('./models/Table');

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/cafeteria', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Menu Items
const menuItems = [
    {
        name: "Classic Burger",
        price: 8.99,
        description: "Juicy beef patty with lettuce, tomato, and cheese",
        image: "/images/classic-burger.jpg",
        category: "Main Course",
        available: true,
        stock: 50
    },
    {
        name: "Caesar Salad",
        price: 6.99,
        description: "Fresh romaine lettuce with caesar dressing and croutons",
        image: "/images/caesar-salad.jpg",
        category: "Salads",
        available: true,
        stock: 30
    },
    {
        name: "Margherita Pizza",
        price: 12.99,
        description: "Traditional pizza with tomato sauce, mozzarella, and basil",
        image: "/images/margherita-pizza.jpg",
        category: "Main Course",
        available: true,
        stock: 25
    },
    {
        name: "Chocolate Brownie",
        price: 4.99,
        description: "Rich chocolate brownie with vanilla ice cream",
        image: "/images/chocolate-brownie.jpg",
        category: "Desserts",
        available: true,
        stock: 40
    },
    {
        name: "Iced Coffee",
        price: 3.99,
        description: "Cold brewed coffee served over ice",
        image: "/images/iced-coffee.jpg",
        category: "Beverages",
        available: true,
        stock: 100
    }
];

// Tables
const tables = [
    {
        tableNumber: 1,
        status: 'vacant',
        capacity: 2
    },
    {
        tableNumber: 2,
        status: 'vacant',
        capacity: 4
    },
    {
        tableNumber: 3,
        status: 'vacant',
        capacity: 4
    },
    {
        tableNumber: 4,
        status: 'vacant',
        capacity: 6
    },
    {
        tableNumber: 5,
        status: 'vacant',
        capacity: 8
    }
];

// Function to seed the database
async function seedDatabase() {
    try {
        // Clear existing data
        await Menu.deleteMany({});
        await Table.deleteMany({});

        // Insert new data
        await Menu.insertMany(menuItems);
        await Table.insertMany(tables);

        console.log('Database seeded successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding database:', error);
        process.exit(1);
    }
}

seedDatabase();
