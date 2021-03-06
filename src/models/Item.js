var mongoose = require('mongoose');

var ItemSchema = new mongoose.Schema({
  name: String,
  description: String,
  price: Number
});

ItemSchema.index({name: 'text'});
mongoose.model('Item', ItemSchema);

module.exports = mongoose.model('Item');