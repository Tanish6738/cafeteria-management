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
    placedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    completedAt: { type: Date, default: Date.now },
    receipt: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt' } // Reference to Receipt
});

// Middleware to update the updatedAt field
OrderHistorySchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('OrderHistory', OrderHistorySchema);
