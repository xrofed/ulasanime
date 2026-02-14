const express = require('express');
const router = express.Router();
const multer = require('multer');
const slugify = require('slugify');
const Post = require('../models/Post');

// --- INTEGRASI GOOGLE INDEXING API ---
const { google } = require('googleapis');

const notifyGoogleIndexingAPI = async (postUrl, actionType = 'URL_UPDATED') => {
    try {
        const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
        let privateKey = process.env.GOOGLE_PRIVATE_KEY;

        // Validasi jika .env belum diisi atau gagal terbaca
        if (!clientEmail || !privateKey) {
            console.log("⚠️ Google Indexing API diabaikan: Kredensial di .env belum disetting.");
            return; 
        }

        // PENTING: Membersihkan karakter aneh dan mengubah literal \n menjadi enter (baris baru)
        privateKey = privateKey.replace(/\\n/g, '\n').replace(/"/g, '').trim();
        
        // MENGGUNAKAN FORMAT OBJEK (Lebih aman untuk versi googleapis terbaru)
        const jwtClient = new google.auth.JWT({
            email: clientEmail,
            key: privateKey,
            scopes: ['https://www.googleapis.com/auth/indexing']
        });

        await jwtClient.authorize();

        const indexing = google.indexing({ version: 'v3', auth: jwtClient });
        await indexing.urlNotifications.publish({
            requestBody: {
                url: postUrl,
                type: actionType, // 'URL_UPDATED' atau 'URL_DELETED'
            }
        });
        
        console.log(`✅ Google Indexing: [${actionType}] sukses dikirim untuk ${postUrl}`);
    } catch (err) {
        console.error(`❌ Gagal ping Google Indexing API:`, err.message);
    }
};

// --- INTEGRASI CLOUDFLARE R2 (AWS SDK V3) ---
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');

// 1. Konfigurasi Client S3 (R2)
const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// 2. Konfigurasi Upload Multer ke R2
const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.R2_BUCKET_NAME,
        acl: 'public-read', // Pastikan bucket R2 diizinkan public access
        contentType: multerS3.AUTO_CONTENT_TYPE, 
        key: function (req, file, cb) {
            const fileName = Date.now().toString() + '-' + slugify(file.originalname, { lower: true });
            cb(null, fileName);
        }
    })
});

// --- HELPER: Hapus Gambar dari R2 ---
const deleteImageFromR2 = async (imageUrl) => {
    if (!imageUrl || imageUrl === 'default.jpg' || !imageUrl.startsWith('http')) return;

    try {
        const fileKey = imageUrl.split('/').pop();
        const deleteParams = {
            Bucket: process.env.R2_BUCKET_NAME,
            Key: fileKey,
        };
        await s3.send(new DeleteObjectCommand(deleteParams));
        console.log(`✅ Gambar dihapus dari R2: ${fileKey}`);
    } catch (err) {
        console.error("❌ Gagal hapus gambar R2:", err);
    }
};

// --- MIDDLEWARE PENGAMAN ---
// (DIPINDAHKAN KE ATAS AGAR BISA DIGUNAKAN OLEH ROUTE DI BAWAHNYA)
const cekLogin = (req, res, next) => {
    if (req.session.isLoggedIn) {
        next();
    } else {
        res.redirect('/admin/login');
    }
};

// ==========================================
// RUTE MANUAL PING GOOGLE INDEX
// ==========================================
router.get('/ping-google/:id', cekLogin, async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        
        if (post && post.status === 'published') {
            const siteUrl = process.env.SITE_URL || 'https://www.ulasanime.fun';
            const postUrl = `${siteUrl}/read/${post.slug}`;
            
            // Panggil fungsi Google Indexing
            await notifyGoogleIndexingAPI(postUrl, 'URL_UPDATED');
            
            // Redirect kembali ke dashboard dengan pesan sukses di URL
            res.redirect('/admin?msg=ping_success');
        } else {
            res.redirect('/admin?msg=ping_failed_draft');
        }
    } catch (e) {
        console.error(e);
        res.redirect('/admin?msg=ping_error');
    }
});

// ==========================================
// RUTE LOGIN & DASHBOARD
// ==========================================

router.get('/login', (req, res) => {
    if (req.session.isLoggedIn) return res.redirect('/admin');
    res.render('admin/login');
});

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        req.session.isLoggedIn = true;
        res.redirect('/admin');
    } else {
        res.render('admin/login', { error: 'Username atau Password salah!' });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/', cekLogin, async (req, res) => {
    try {
        const posts = await Post.find().sort({ createdAt: -1 });
        res.render('admin/dashboard', { posts });
    } catch (error) { res.send(error); }
});

router.get('/post', cekLogin, (req, res) => {
    res.render('admin/add');
});

// ==========================================
// 1. PROSES TAMBAH POSTINGAN
// ==========================================
router.post('/post', cekLogin, upload.single('image'), async (req, res) => {
    try {
        let { title, content, category, tags, status, slug, seoDescription } = req.body;

        let listCategory = [];
        if (category) { try { listCategory = JSON.parse(category).map(i => i.value); } catch (e) { listCategory = [category]; } }
        
        let listTags = [];
        if (tags) { try { listTags = JSON.parse(tags).map(i => i.value); } catch (e) { listTags = [tags]; } }

        let finalSlug = "";
        if (slug && slug.trim() !== "") {
            finalSlug = slugify(slug, { lower: true, strict: true });
        } else {
            finalSlug = slugify(title, { lower: true, strict: true });
        }

        const checkSlug = await Post.findOne({ slug: finalSlug });
        if (checkSlug) finalSlug += '-' + Date.now();

        let imageUrl = 'default.jpg';
        if (req.file) {
            imageUrl = `${process.env.R2_PUBLIC_DOMAIN}/${req.file.key}`;
        }

        const currentStatus = status || 'published';

        const newPost = new Post({
            title,
            slug: finalSlug,
            content,
            category: listCategory,
            tags: listTags,
            image: imageUrl, 
            status: currentStatus,
            seoDescription: seoDescription || ''
        });

        await newPost.save();

        // [SEO] Ping Google Indexing API jika dipublish
        if (currentStatus === 'published') {
            const siteUrl = process.env.SITE_URL || 'https://www.ulasanime.fun';
            const postUrl = `${siteUrl}/read/${finalSlug}`;
            notifyGoogleIndexingAPI(postUrl, 'URL_UPDATED'); // Berjalan di background (tanpa await) agar panel admin tidak lemot
        }

        res.redirect('/admin');

    } catch (e) {
        console.log(e);
        res.send("Gagal menambah postingan: " + e.message);
    }
});

router.get('/edit/:id', cekLogin, async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        res.render('admin/edit', { post });
    } catch (e) { res.redirect('/admin'); }
});

// ==========================================
// 2. PROSES UPDATE POSTINGAN
// ==========================================
router.post('/edit/:id', cekLogin, upload.single('image'), async (req, res) => {
    try {
        let { title, content, category, tags, status, slug, seoDescription, oldImage } = req.body;
        
        let listCategory = [];
        if (category) { try { listCategory = JSON.parse(category).map(i => i.value); } catch (e) { listCategory = [category]; } }
        
        let listTags = [];
        if (tags) { try { listTags = JSON.parse(tags).map(i => i.value); } catch (e) { listTags = [tags]; } }

        let finalSlug = "";
        if (slug && slug.trim() !== "") {
            finalSlug = slugify(slug, { lower: true, strict: true });
        } else {
            finalSlug = slugify(title, { lower: true, strict: true });
        }

        const checkSlug = await Post.findOne({ slug: finalSlug, _id: { $ne: req.params.id } });
        if (checkSlug) finalSlug += '-' + Date.now();

        let newImage = oldImage;
        if (req.file) {
            newImage = `${process.env.R2_PUBLIC_DOMAIN}/${req.file.key}`;
            await deleteImageFromR2(oldImage);
        }

        const currentStatus = status || 'published';

        await Post.findByIdAndUpdate(req.params.id, {
            title,
            slug: finalSlug,
            content,
            category: listCategory,
            tags: listTags,
            image: newImage,
            status: currentStatus,
            seoDescription: seoDescription || ''
        });

        // [SEO] Ping Google Indexing API sesuai status perubahan
        const siteUrl = process.env.SITE_URL || 'https://www.ulasanime.fun';
        const postUrl = `${siteUrl}/read/${finalSlug}`;
        
        if (currentStatus === 'published') {
            notifyGoogleIndexingAPI(postUrl, 'URL_UPDATED'); 
        } else if (currentStatus === 'draft') {
            // Beri tahu Google untuk menghapus URL dari pencarian jika di-draft
            notifyGoogleIndexingAPI(postUrl, 'URL_DELETED'); 
        }

        res.redirect('/admin');

    } catch (e) {
        console.log(e);
        res.send("Gagal update postingan: " + e.message);
    }
});

// ==========================================
// 3. HAPUS POSTINGAN
// ==========================================
router.get('/delete/:id', cekLogin, async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        
        if (post.image) {
            await deleteImageFromR2(post.image);
        }

        // [SEO] Beri tahu Google bahwa artikel ini telah dihapus permanen
        if (post.status === 'published') {
            const siteUrl = process.env.SITE_URL || 'https://www.ulasanime.fun';
            const postUrl = `${siteUrl}/read/${post.slug}`;
            notifyGoogleIndexingAPI(postUrl, 'URL_DELETED');
        }

        await Post.findByIdAndDelete(req.params.id);
        res.redirect('/admin');
    } catch (e) {
        console.log(e);
        res.redirect('/admin');
    }
});

module.exports = router;