const mongoose = require('mongoose'); 
const Schema = mongoose.Schema;

const OrderSchema = new Schema({
    items: [
        {
            menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'Menu', required: true },
            quantity: { type: Number, required: true },
        }
    ],
    tableNumber: { type: Number, required: true }, 
    total: { type: Number, required: true },
    status: { 
        type: String, 
        enum: ['pending', 'preparing', 'ready', 'served', 'completed', 'canceled'], 
        default: 'pending' 
    },
    paymentStatus: {
        type: String,
        enum: ['unpaid', 'paid'],
        default: 'unpaid'
    },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true },
    placedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date } 
}, {
    timestamps: true
});

OrderSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Orders', OrderSchema);
