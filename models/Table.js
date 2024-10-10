const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const TableSchema = new Schema({
    tableNumber: { type: Number, required: true, unique: true },
    status: { 
        type: String, 
        enum: ['vacant', 'occupied', 'reserved'], 
        default: 'vacant' 
    },
    reservedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Users' }, 
    capacity: { type: Number, required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Orders' }, 
    reservationStartTime: { type: Date , default: Date.now }, 
    reservationEndTime: { type: Date  }   
}, {
    timestamps: true
});

module.exports = mongoose.model('Tables', TableSchema);
