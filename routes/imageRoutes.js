const express = require("express");
const multer = require("multer");
const sharp = require("sharp");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/bmp",
      "image/tiff"
    ]);

    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, WEBP, BMP and TIFF images are supported."));
    }

    cb(null, true);
  }
});

router.post("/process", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Please select an image." });
    }

    const action = String(req.body.action || "");
    const quality = Math.min(100, Math.max(10, Number(req.body.quality) || 75));

    if (!["compress", "resize", "enhance", "rotate"].includes(action)) {
      return res.status(400).json({ message: "Unsupported image operation." });
    }

    let image = sharp(req.file.buffer, {
      limitInputPixels: 40000000
    });

    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      return res.status(400).json({ message: "Invalid image file." });
    }

    if (action === "resize") {
      const width = Number(req.body.width);
      const height = Number(req.body.height);

      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 10000 ||
        height > 10000
      ) {
        return res.status(400).json({ message: "Enter valid image width and height." });
      }

      image = image.resize(width, height, { fit: "fill" });
    }

    if (action === "rotate") {
      const angle = Number(req.body.rotation) || 0;

      if (!Number.isFinite(angle) || Math.abs(angle) > 3600) {
        return res.status(400).json({ message: "Invalid rotation angle." });
      }

      image = image.rotate(angle);
    }

    if (action === "enhance") {
      const strength = quality / 100;

      image = image
        .modulate({
          brightness: 1 + strength * 0.12,
          saturation: 1 + strength * 0.15
        })
        .sharpen();
    }

    let output;
    let contentType;
    let extension;

    // Keep common formats. BMP/TIFF are converted to JPEG for easy browser download.
    if (metadata.format === "png") {
      output = await image.png({ compressionLevel: 9 }).toBuffer();
      contentType = "image/png";
      extension = "png";
    } else if (metadata.format === "webp") {
      output = await image.webp({
        quality: action === "compress" ? quality : 90
      }).toBuffer();
      contentType = "image/webp";
      extension = "webp";
    } else {
      output = await image.jpeg({
        quality: action === "compress" ? quality : 90,
        mozjpeg: true
      }).toBuffer();
      contentType = "image/jpeg";
      extension = "jpg";
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="docufix-edited.${extension}"`
    );
    res.setHeader("X-Processed-Size", String(output.length));

    return res.send(output);
  } catch (error) {
    console.error("Image processing error:", error);
    return res.status(400).json({
      message: "Image processing failed. Please check the image file."
    });
  }
});

module.exports = router;
