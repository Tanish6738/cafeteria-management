const mongoose = require('mongoose');

const OrderHistorySchema = new mongoose.Schema({
    items: [{
        menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', required: true },
        quantity: { type: Number, required: true }
    }],
    tableNumber: { type: String, required: true },
    total: { type: Number, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true },
    status: { type: String, default: 'completed' },
    completedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('OrderHistory', OrderHistorySchema);
