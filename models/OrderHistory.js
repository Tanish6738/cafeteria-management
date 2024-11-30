const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const OrderHistorySchema = new Schema({
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Orders', required: true },
    status: {
        type: String,
        enum: ['pending', 'preparing', 'ready', 'served', 'cancelled'],
        required: true
    },
    timestamp: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users' },
    notes: { type: String },
    previousStatus: { type: String },
    reason: { type: String }
}, {
    timestamps: true
});

// Index for faster queries
OrderHistorySchema.index({ order: 1, timestamp: -1 });

module.exports = mongoose.model('OrderHistory', OrderHistorySchema);
