const mongoose = require('mongoose');
const Schema = mongoose.Schema;

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

// Static method to validate ObjectId
MenuSchema.statics.isValidId = function(id) {
    return mongoose.Types.ObjectId.isValid(id);
};

module.exports = mongoose.model('Menu', MenuSchema);
