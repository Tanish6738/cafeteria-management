const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PaymentSchema = new Schema({
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Orders', required: true },
    amount: { type: Number, required: true },
    paymentMethod: {
        type: String,
        enum: ['cash', 'credit_card', 'debit_card', 'upi', 'wallet'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending'
    },
    transactionId: { type: String },
    paymentDate: { type: Date, default: Date.now },
    refundAmount: { type: Number },
    refundDate: { type: Date },
    refundReason: { type: String },
    notes: { type: String }
}, {
    timestamps: true
});

// Add index for faster queries
PaymentSchema.index({ order: 1, status: 1 });

module.exports = mongoose.model('Payment', PaymentSchema);
