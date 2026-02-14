require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const slugify = require('slugify');
const session = require('express-session');

// Import Model Database
const Post = require('./models/Post');

// Import Rute Admin
const adminRoutes = require('./routes/admin');

const app = express();

// --- 1. KONEKSI DATABASE ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Terhubung!'))
    .catch(err => console.error('❌ Gagal Konek DB:', err));

// --- 2. MIDDLEWARE & SETUP ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'kunci-rahasia-negara-konoha',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
    res.locals.isLoggedIn = req.session.isLoggedIn || false;
    next();
});

// Variabel Global & Default SEO
app.use((req, res, next) => {
    res.locals.siteName = process.env.SITE_NAME || "AnimeNews ID";
    res.locals.siteUrl = process.env.SITE_URL || "http://localhost:3000";

    res.locals.createSlug = (text) => {
        return slugify(text || "", { lower: true, strict: true });
    };

    // Default SEO Data
    res.locals.seoData = {
        seo_title: res.locals.siteName,
        seo_description: "Portal berita Anime, Manga, dan Game terlengkap dan terupdate.",
        // SETTING ROBOTS DEFAULT (Index semua halaman secara default)
        robots: "index, follow, max-snippet:-1, max-video-preview:-1, max-image-preview:large",
        og_image: `${res.locals.siteUrl}/img/default-cover.jpg`,
        current_url: `${res.locals.siteUrl}${req.path}`,
        og_type: "website"
    };
    next();
});

// --- 3. MOUNT RUTE ADMIN ---
app.use('/admin', adminRoutes);

// --- 4. RUTE FRONTEND ---

// Halaman Home
app.get('/', async (req, res) => {
    try {
        // FIX: Tambahkan filter status published agar draft tidak muncul di home
        const posts = await Post.find({ status: 'published' }).sort({ createdAt: -1 }).limit(13);
        const headline = posts.length > 0 ? posts[0] : null;
        const listPosts = posts.length > 1 ? posts.slice(1) : [];

        res.locals.seoData.seo_title = `${res.locals.siteName} - Berita Anime dan Manga Terbaru Hari Ini`;
        res.locals.seoData.seo_description = "Baca berita anime, manga, game, dan budaya pop Jepang terbaru hari ini.";

        if (headline) {
            res.locals.seoData.og_image = headline.image.startsWith('http')
                ? headline.image
                : `${res.locals.siteUrl}/uploads/${headline.image}`;
        }

        res.render('index', { headline, listPosts, seoData: res.locals.seoData });
    } catch (err) {
        console.log(err);
        res.status(500).send("Error memuat halaman depan");
    }
});

// --- API LOAD MORE (Untuk Tombol "Muat Lebih Banyak") ---
app.get('/api/load-more', async (req, res) => {
    try {
        const skip = parseInt(req.query.skip) || 0;
        const limit = 6; 

        const posts = await Post.find({ status: 'published' }) // Sudah aman
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json(posts); 
    } catch (err) {
        res.status(500).json({ error: 'Gagal memuat berita' });
    }
});

// Halaman Baca Berita
app.get('/read/:slug', async (req, res) => {
    try {
        const post = await Post.findOne({ slug: req.params.slug, status: 'published' }); // Sudah aman
        if (!post) return res.status(404).render('404', { message: 'Berita tidak ditemukan' });

        const relatedPosts = await Post.find({
            _id: { $ne: post._id },
            category: { $in: post.category },
            status: 'published' // Sudah aman
        }).select('title slug image').sort({ createdAt: -1 }).limit(3); 

        const sidebarPosts = await Post.find({ 
            _id: { $ne: post._id }, 
            status: 'published' // Sudah aman
        })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('title slug image category createdAt');
        
        const meta_image = post.image.startsWith('http') ? post.image : `${res.locals.siteUrl}/uploads/${post.image}`;
        const uploadDate = new Date(post.createdAt);
        const formattedDate = uploadDate.toISOString().replace('Z', '+07:00');
        const cleanContent = post.content.replace(/(<([^>]+)>)/ig, "");
        const seoDescription = post.seoDescription || cleanContent.substring(0, 155) + "...";
        const seoTags = post.tags && post.tags.length > 0 ? post.tags : [];

        const seoData = {
            seo_title: `${post.title} | ${res.locals.siteName}`,
            seo_description: seoDescription,
            robots: "index, follow, max-snippet:-1, max-video-preview:-1, max-image-preview:large",
            seo_canonical: `${res.locals.siteUrl}/read/${post.slug}`,
            seo_keywords: seoTags.join(', '),
            og_type: "article",
            og_image: meta_image,
            og_image_width: 854,
            og_image_height: 480,
            og_date: formattedDate,
            twitter_card: "summary_large_image",
            twitter_site: `@${res.locals.siteName}`,
            twitter_image: meta_image,
            schema_publisher_name: res.locals.siteName,
            schema_author_name: "Redaksi",
            schema_sections: [...(post.category || []), 'Artikel'],
            schema_date: formattedDate,
            current_url: `${res.locals.siteUrl}/read/${post.slug}`
        };

        res.render('single', { post, seoData, relatedPosts, sidebarPosts });

    } catch (err) {
        console.error(err);
        res.status(500).send("Terjadi kesalahan server");
    }
});

// Halaman Kategori
app.get('/category/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        const prettyName = slug.replace(/-/g, ' ');
        const displayName = prettyName.replace(/\b\w/g, l => l.toUpperCase());
        
        const posts = await Post.find({ 
            category: { $regex: new RegExp('^' + prettyName + '$', "i") },
            status: 'published' // Sudah aman
        }).sort({ createdAt: -1 });

        const sidebarPosts = await Post.find({ status: 'published' }) // Sudah aman
            .sort({ createdAt: -1 })
            .limit(10)
            .select('title slug image category createdAt');

        res.locals.seoData.seo_title = `Berita Kategori ${displayName} | ${res.locals.siteName}`;
        res.locals.seoData.seo_description = `Kumpulan berita terbaru seputar ${displayName}.`;

        res.render('category', { posts, categoryName: displayName, currentSlug: slug, sidebarPosts });
    } catch (err) {
        res.status(500).send("Error memuat kategori");
    }
});

// Halaman Tags
app.get('/tag/:slug', async (req, res) => {
    try {
        const slug = req.params.slug;
        const prettyName = slug.replace(/-/g, ' ');
        const displayName = prettyName.replace(/\b\w/g, l => l.toUpperCase());

        const posts = await Post.find({ 
            tags: { $regex: new RegExp('^' + prettyName + '$', "i") },
            status: 'published' // Sudah aman
        }).sort({ createdAt: -1 });

        const sidebarPosts = await Post.find({ status: 'published' }) // Sudah aman
            .sort({ createdAt: -1 })
            .limit(10)
            .select('title slug image category createdAt');

         res.locals.seoData.seo_title = `Topik #${displayName} | ${res.locals.siteName}`;
         res.locals.seoData.seo_description = `Berita terkini dengan topik #${displayName}.`;

        res.render('tag', { posts, tagName: displayName, sidebarPosts });
    } catch (err) {
        res.status(500).send("Error memuat tags");
    }
});

// Halaman Pencarian (NOINDEX)
app.get('/search', async (req, res) => {
    try {
        const query = req.query.q || "";
        let posts = [];
        if (query) {
            // FIX: Tambahkan filter status published di pencarian
            posts = await Post.find({
                title: { $regex: query, $options: 'i' },
                status: 'published'
            }).sort({ createdAt: -1 });
        }

        res.locals.seoData.seo_title = `Pencarian: ${query} | ${res.locals.siteName}`;
        res.locals.seoData.seo_description = `Menampilkan hasil pencarian untuk "${query}".`;
        res.locals.seoData.current_url = `${res.locals.siteUrl}/search?q=${encodeURIComponent(query)}`;

        res.locals.seoData.robots = "noindex, follow";

        res.render('search', { posts, query, seoData: res.locals.seoData });

    } catch (err) {
        console.error(err);
        res.status(500).send("Terjadi kesalahan saat mencari berita");
    }
});

// ==========================================
// RUTE RSS FEED & SITEMAP (SEO TOOLS)
// ==========================================

// 1. Main RSS Feed (Semua Berita Terbaru)
app.get('/rss', async (req, res) => {
    try {
        const siteUrl = res.locals.siteUrl; 
        const limit = 50;

        // FIX: Tambahkan filter status published pada RSS global
        const posts = await Post.find({ status: 'published' }).sort({ createdAt: -1 }).limit(limit);
        const lastBuildDate = new Date().toUTCString();

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
    <channel>
        <title>${res.locals.siteName} - Berita Terbaru</title>
        <link>${siteUrl}</link>
        <description>Update berita Anime, Manga, dan Game terbaru.</description>
        <language>id-ID</language>
        <lastBuildDate>${lastBuildDate}</lastBuildDate>
        <atom:link href="${siteUrl}/rss" rel="self" type="application/rss+xml" />`;

        posts.forEach(post => {
            const postLink = `${siteUrl}/read/${post.slug}`;

            let thumbUrl = `${siteUrl}/img/default-cover.jpg`;
            if (post.image) {
                thumbUrl = post.image.startsWith('http') ? post.image : `${siteUrl}/uploads/${post.image}`;
            }

            const cleanDesc = post.content.replace(/(<([^>]+)>)/ig, "").substring(0, 300);

            xml += `
        <item>
            <title><![CDATA[${post.title}]]></title>
            <link>${postLink}</link>
            <guid isPermaLink="true">${postLink}</guid>
            <description><![CDATA[
                <img src="${thumbUrl}" width="320" height="180" style="object-fit:cover;" /><br/>
                <p>${cleanDesc}...</p>
                <p><strong>Kategori:</strong> ${post.category.join(', ')}</p>
            ]]></description>
            <media:content url="${thumbUrl}" medium="image">
                <media:title type="plain"><![CDATA[${post.title}]]></media:title>
            </media:content>
            <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
        </item>`;
        });

        xml += `
    </channel>
</rss>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error generating RSS");
    }
});

// 2. RSS by Category
app.get('/rss/category/:slug', async (req, res) => {
    try {
        const siteUrl = res.locals.siteUrl;
        const categorySlug = req.params.slug;
        const categoryName = categorySlug.replace(/-/g, ' ');

        // FIX: Tambahkan filter status published pada RSS per kategori
        const posts = await Post.find({
            category: { $regex: new RegExp('^' + categoryName + '$', "i") },
            status: 'published'
        }).sort({ createdAt: -1 }).limit(20);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
    <channel>
        <title>Berita Kategori: ${categoryName.toUpperCase()}</title>
        <link>${siteUrl}/category/${categorySlug}</link>
        <description>Feed terbaru seputar ${categoryName}</description>
        <language>id-ID</language>
        <atom:link href="${siteUrl}/rss/category/${categorySlug}" rel="self" type="application/rss+xml" />`;

        posts.forEach(post => {
            const postLink = `${siteUrl}/read/${post.slug}`;

            let thumbUrl = `${siteUrl}/img/default-cover.jpg`;
            if (post.image) {
                thumbUrl = post.image.startsWith('http') ? post.image : `${siteUrl}/uploads/${post.image}`;
            }

            const cleanDesc = post.content.replace(/(<([^>]+)>)/ig, "").substring(0, 200);

            xml += `
        <item>
            <title><![CDATA[${post.title}]]></title>
            <link>${postLink}</link>
            <guid>${postLink}</guid>
            <description><![CDATA[
                <img src="${thumbUrl}" width="300" /><br/>
                ${cleanDesc}...
            ]]></description>
            <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
        </item>`;
        });

        xml += `
    </channel>
</rss>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// 3. General Sitemap (Artikel + Gambar + Tags)
app.get('/sitemap.xml', async (req, res) => {
    try {
        const siteUrl = res.locals.siteUrl;

        // FIX: Tambahkan filter status published pada sitemap reguler
        const posts = await Post.find({ status: 'published' })
            .select('slug title image tags createdAt')
            .sort({ createdAt: -1 });

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" 
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
    
    <url>
        <loc>${siteUrl}/</loc>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>
    <url>
        <loc>${siteUrl}/category/anime</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>${siteUrl}/category/manga</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>${siteUrl}/category/jadwal</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>${siteUrl}/about</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>${siteUrl}/privacy-policy</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>${siteUrl}/contact</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>
    <url>
        <loc>${siteUrl}/disclaimer</loc>
        <changefreq>weekly</changefreq>
        <priority>0.8</priority>
    </url>`;

        const uniqueTags = new Set();

        posts.forEach(post => {
            const postUrl = `${siteUrl}/read/${post.slug}`;

            let thumbUrl = `${siteUrl}/img/default-cover.jpg`;
            if (post.image) {
                thumbUrl = post.image.startsWith('http') ? post.image : `${siteUrl}/uploads/${post.image}`;
            }

            const date = new Date(post.createdAt).toISOString().split('T')[0];

            if (post.tags && post.tags.length > 0) {
                post.tags.forEach(t => {
                    if (t) {
                        const tagSlug = res.locals.createSlug(t);
                        uniqueTags.add(tagSlug);
                    }
                });
            }

            xml += `
    <url>
        <loc>${postUrl}</loc>
        <lastmod>${date}</lastmod>
        <priority>0.9</priority>
        <image:image>
            <image:loc>${thumbUrl}</image:loc>
            <image:title><![CDATA[${post.title}]]></image:title>
        </image:image>
    </url>`;
        });

        uniqueTags.forEach(tagSlug => {
            xml += `
    <url>
        <loc>${siteUrl}/tag/${tagSlug}</loc>
        <changefreq>weekly</changefreq>
        <priority>0.6</priority>
    </url>`;
        });

        xml += `
</urlset>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error sitemap");
    }
});

// 5. Google News Sitemap (Khusus 48 Jam Terakhir + Gambar)
app.get('/sitemap-news.xml', async (req, res) => {
    try {
        const siteUrl = res.locals.siteUrl; 
        const siteName = res.locals.siteName;

        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

        // FIX: Tambahkan filter status published agar Google News menolak index draft
        const posts = await Post.find({
            createdAt: { $gte: twoDaysAgo },
            status: 'published'
        })
            .select('title slug createdAt image') 
            .sort({ createdAt: -1 })
            .limit(1000);

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`;

        posts.forEach(post => {
            const postUrl = `${siteUrl}/read/${post.slug}`;
            const date = new Date(post.createdAt).toISOString();

            let imageUrl = `${siteUrl}/img/default-cover.jpg`; 
            if (post.image) {
                imageUrl = post.image.startsWith('http')
                    ? post.image
                    : `${siteUrl}/uploads/${post.image}`;
            }

            xml += `
    <url>
        <loc>${postUrl}</loc>
        <news:news>
            <news:publication>
                <news:name>${siteName}</news:name>
                <news:language>id</news:language>
            </news:publication>
            <news:publication_date>${date}</news:publication_date>
            <news:title><![CDATA[${post.title}]]></news:title>
        </news:news>
        <image:image>
            <image:loc>${imageUrl}</image:loc>
            <image:title><![CDATA[${post.title}]]></image:title>
        </image:image>
    </url>`;
        });

        xml += `
</urlset>`;

        res.header('Content-Type', 'application/xml');
        res.send(xml);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error generating News Sitemap");
    }
});

// --- HALAMAN STATIS ---

app.get('/about', (req, res) => {
    res.locals.seoData.seo_title = `Tentang Kami | ${res.locals.siteName}`;
    res.locals.seoData.seo_description = "Informasi tentang redaksi, visi, dan misi kami.";
    res.render('pages/about');
});

app.get('/contact', (req, res) => {
    res.locals.seoData.seo_title = `Hubungi Redaksi | ${res.locals.siteName}`;
    res.locals.seoData.seo_description = "Kontak kerjasama, media partner, dan laporan berita.";
    res.render('pages/contact');
});

app.get('/privacy-policy', (req, res) => {
    res.locals.seoData.seo_title = `Kebijakan Privasi | ${res.locals.siteName}`;
    res.locals.seoData.robots = "noindex, follow"; 
    res.render('pages/privacy');
});

app.get('/disclaimer', (req, res) => {
    res.locals.seoData.seo_title = `Disclaimer | ${res.locals.siteName}`;
    res.locals.seoData.robots = "noindex, follow";
    res.render('pages/disclaimer');
});

app.use((req, res, next) => {
    res.locals.seoData.seo_title = `404 Halaman Tidak Ditemukan | ${res.locals.siteName}`;
    res.locals.seoData.seo_description = "Halaman yang Anda cari tidak ditemukan.";
    res.locals.seoData.robots = "noindex, follow"; 

    res.status(404).render('404');
});

// Jalankan Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));
