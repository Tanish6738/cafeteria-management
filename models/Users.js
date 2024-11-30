const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
    password: { type: String, required: true },
    role: {
        type: String,
        enum: ['admin', 'staff', 'customer'],
        default: 'customer'
    },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    mobile: { type: String },
    orders: [{ type: Schema.Types.ObjectId, ref: 'Order' }],
    paymentHistory: [{ type: Schema.Types.ObjectId, ref: 'Payment' }],
    active: { type: Boolean, default: true },
    lastLogin: { type: Date }
}, {
    timestamps: true
});

module.exports = mongoose.model('Users', UserSchema);
