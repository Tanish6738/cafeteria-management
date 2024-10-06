const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PaymentSchema = new Schema({
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Users', required: true },
    tableNumber: { type: Number, required: true }, // Associated table number
    orders: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Orders',
        required: true 
    }], // All related orders for this payment
    totalAmount: { type: Number, required: true }, // Total amount paid
    taxAmount: { type: Number, default: 0 }, // Tax amount (if applicable)
    serviceCharge: { type: Number, default: 0 }, // Service charge (if applicable)
    paymentStatus: { 
        type: String, 
        enum: ['pending', 'paid'], 
        default: 'pending'
    },
    paymentMethod: { type: String, enum: ['card', 'cash'], required: true },
    paymentDate: { type: Date, default: Date.now }, // Date of the payment
    receipt: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt' }, // Reference to Receipt
}, {
    timestamps: true
});

// Pre-save hook to ensure all orders are 'completed' before payment
PaymentSchema.pre('save', async function(next) {
    const orders = await mongoose.model('Orders').find({ _id: { $in: this.orders } });
    const allCompleted = orders.every(order => order.status === 'completed');
    if (!allCompleted) {
        return next(new Error('All orders must be marked as completed before making payment.'));
    }
    next();
});

// Post-save hook to mark table as vacant after payment
PaymentSchema.post('save', async function(doc, next) {
    if (doc.paymentStatus === 'paid') {
        // Update table status to 'vacant'
        await mongoose.model('Tables').updateOne(
            { tableNumber: doc.tableNumber }, 
            { $set: { status: 'vacant', reservedBy: null } }
        );
    }
    next();
});

module.exports = mongoose.model('Payment', PaymentSchema);
