const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    image: { type: String },
    content: { type: String, required: true },
    category: { type: Array, default: [] },
    tags: { type: Array, default: [] },
    status: { type: String, default: 'published', enum: ['published', 'draft'] },
    
    // TAMBAHAN BARU: Custom Meta Description
    seoDescription: { type: String, default: '' },
    
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Post', PostSchema);