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
    orders: [{ type: Schema.Types.ObjectId, ref: 'Orders' }],
    paymentHistory: [{ type: Schema.Types.ObjectId, ref: 'Payment' }],
    active: { type: Boolean, default: true },
    lastLogin: { type: Date }
}, {
    timestamps: true
});

// Static method to validate ObjectId
UserSchema.statics.isValidId = function(id) {
    return mongoose.Types.ObjectId.isValid(id);
};

module.exports = mongoose.model('Users', UserSchema);
