require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const Post = require('./models/Post'); // Pastikan path model benar

// --- KONFIGURASI ---
const LOCAL_FOLDER = './public/uploads';

// 1. Setup R2 Client
const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// Helper: Deteksi Mime Type sederhana
function getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.png') return 'image/png';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    return 'application/octet-stream';
}

async function migrateImages() {
    try {
        // 2. Konek Database
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB Terhubung');

        // 3. Baca Folder Uploads
        if (!fs.existsSync(LOCAL_FOLDER)) {
            console.log('❌ Folder public/uploads tidak ditemukan!');
            return;
        }

        const files = fs.readdirSync(LOCAL_FOLDER);
        console.log(`📂 Ditemukan ${files.length} file di folder uploads.`);

        for (const file of files) {
            // Skip file sistem/hidden (seperti .DS_Store atau .gitkeep)
            if (file.startsWith('.')) continue;

            const filePath = path.join(LOCAL_FOLDER, file);
            const fileContent = fs.readFileSync(filePath);
            const contentType = getContentType(file);

            console.log(`\n⬆️  Sedang memproses: ${file}...`);

            // A. UPLOAD KE R2
            try {
                await s3.send(new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET_NAME,
                    Key: file, // Nama file tetap sama
                    Body: fileContent,
                    ContentType: contentType,
                    ACL: 'public-read' // Agar bisa diakses publik
                }));
                console.log(`   ✅ Sukses upload ke R2`);
            } catch (err) {
                console.error(`   ❌ Gagal upload ke R2:`, err.message);
                continue; // Lanjut ke file berikutnya jika gagal
            }

            // B. UPDATE DATABASE
            // Link baru R2
            const r2Url = `${process.env.R2_PUBLIC_DOMAIN}/${file}`;

            // Cari post yang menggunakan nama file ini (dan belum berupa link http)
            const result = await Post.updateMany(
                { image: file }, // Cari yang image-nya persis nama file (misal: "123.jpg")
                { $set: { image: r2Url } } // Ubah jadi "https://pub.r2.../123.jpg"
            );

            if (result.modifiedCount > 0) {
                console.log(`   🔄 Database diupdate: ${result.modifiedCount} artikel.`);
            } else {
                console.log(`   ⚠️  File ada di folder, tapi tidak dipakai di database (atau sudah diupdate).`);
            }
        }

        console.log('\n🎉 --- MIGRASI SELESAI ---');

    } catch (err) {
        console.error('Terjadi Kesalahan Fatal:', err);
    } finally {
        mongoose.connection.close();
    }
}

// Jalankan Script
migrateImages();