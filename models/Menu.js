const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { isValidObjectId } = mongoose;

const MenuSchema = new Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    description: { type: String, required: true },
    image: { type: String, required: true },
    category: { type: String, required: true }, 
    available: { type: Boolean, default: true },
    stock: { type: Number, default: 0, min: [0, 'Stock cannot be negative'] }
}, {
    timestamps: true
});

// Middleware to validate ObjectId
MenuSchema.pre('findOne', function(next) {
    if (!isValidObjectId(this.getQuery()._id)) {
        return next(new Error('Invalid ObjectId'));
    }
    next();
});

module.exports = mongoose.model('Menu', MenuSchema);
