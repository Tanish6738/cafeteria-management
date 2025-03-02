const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ReceiptSchema = new Schema({
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Users' }, // Add this field
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Orders', required: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true },
    receiptNumber: { type: String, required: true, unique: true },
    items: [{
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        price: { type: Number, required: true },
        subtotal: { type: Number, required: true }
    }],
    subtotal: { type: Number, required: true },
    tax: { type: Number, required: true },
    total: { type: Number, required: true },
    generatedAt: { type: Date, default: Date.now },
    cashier: { type: mongoose.Schema.Types.ObjectId, ref: 'Users' }
}, {
    timestamps: true
});

// Generate receipt number before saving
ReceiptSchema.pre('save', async function(next) {
    if (this.isNew) {
        const date = new Date();
        const prefix = date.getFullYear().toString().substr(-2) + 
                      (date.getMonth() + 1).toString().padStart(2, '0');
        const count = await this.constructor.countDocuments();
        this.receiptNumber = `${prefix}-${(count + 1).toString().padStart(4, '0')}`;
    }
    next();
});

module.exports = mongoose.model('Receipt', ReceiptSchema);
