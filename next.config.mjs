/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server Actions transport the admin media-upload payload (File objects →
  // uploadContentMedia / uploadMultipleContentMedia) through the action POST
  // body. Next.js caps that body at 1 MB by default, which rejects any image
  // at or above the app's own CONTENT_UPLOAD.maxImageBytes (10 MB). Raise the
  // ceiling to match the image limit; video remains client-bounded at 100 MB
  // by CONTENT_UPLOAD.maxVideoBytes but is impractical through server actions
  // on serverless hosts — direct client-side upload is recommended there.
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  // Images: if admin/content uses next/image, add a `images` domain here.
};

export default nextConfig;
