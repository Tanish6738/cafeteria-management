const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const OrderSchema = new Schema({
    tableNumber: { type: Number, required: true },
    items: [{
        menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', required: true },
        quantity: { type: Number, required: true, min: 1 },
        price: { type: Number, required: true },
        notes: { type: String }
    }],
    status: {
        type: String,
        enum: ['pending', 'preparing', 'ready', 'served', 'cancelled'],
        default: 'pending'
    },
    totalAmount: { type: Number, required: true },
    orderType: {
        type: String,
        enum: ['dine-in', 'takeaway'],
        required: true
    },
    specialInstructions: { type: String }
}, {
    timestamps: true
});

module.exports = mongoose.model('Orders', OrderSchema);
