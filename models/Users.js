const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
    username: { type: String, required: true },
    password: { type: String, required: true },
    role: { 
        type: String, 
        enum: ['admin', 'customer'], 
        default: 'customer' 
    }, 
    email: { type: String, required: true, unique: true },
    mobile: { 
        type: String, 
        required: true, 
        match: [/^\d{10}$/, 'Mobile number must be 10 digits'] 
    },
    orders: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Orders'
        }
    ],
    paymentHistory: [
        {
            orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Orders' },
            amount: { type: Number, required: true },
            date: { type: Date, default: Date.now }
        }
    ]
}, {
    timestamps: true
});

module.exports = mongoose.model('Users', UserSchema);
