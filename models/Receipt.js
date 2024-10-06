const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ReceiptSchema = new Schema({
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true }, // Reference to the related payment
    tableNumber: { type: Number, required: true }, // Track the table number associated with the receipt
    orders: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Orders',
        required: true
    }], // Store all related orders for this receipt
    totalAmount: { type: Number, required: true }, // Total amount paid
    taxAmount: { type: Number, default: 0 }, // Tax amount (if applicable)
    serviceCharge: { type: Number, default: 0 }, // Service charge (if applicable)
    paymentMethod: { type: String, enum: ['card', 'cash'], required: true },
    receiptDate: { type: Date, default: Date.now }, // Date when the receipt was generated
}, {
    timestamps: true
});

// Middleware to check if the payment is completed before generating the receipt
ReceiptSchema.pre('save', async function(next) {
    const payment = await mongoose.model('Payment').findById(this.paymentId);
    if (!payment || payment.paymentStatus !== 'paid') {
        return next(new Error('Cannot generate receipt until payment is completed.'));
    }
    next();
});

module.exports = mongoose.model('Receipt', ReceiptSchema);
