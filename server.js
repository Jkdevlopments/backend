
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");

const pdfRoutes = require("./routes/pdfRoutes");

const app = express();

// =====================================
// RENDER CONFIGURATION
// =====================================

const PORT = process.env.PORT || 10000;
const HOST = "0.0.0.0";

console.log("Environment:", process.env.NODE_ENV || "development");

// =====================================
// CORS CONFIGURATION
// =====================================

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",

  // Firebase Hosting
  "https://akwebp.web.app",
  "https://akwebp.firebaseapp.com"
];

const envOrigins = process.env.CLIENT_ORIGINS
  ? process.env.CLIENT_ORIGINS.split(",")
      .map(origin => origin.trim())
      .filter(Boolean)
  : [];

const allowedOrigins = [
  ...new Set([...defaultOrigins, ...envOrigins])
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.error("Blocked CORS origin:", origin);
    return callback(new Error("Not allowed by CORS"));
  },

  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization"
  ],

  exposedHeaders: [
    "Content-Disposition",

    "X-Original-Size",
    "X-Processed-Size",
    "X-Saved-Size",
    "X-Compression-Percent",
    "X-Size-Change-Percent",
    "X-Compression-Applied",

    "X-Output-Width",
    "X-Output-Height",
    "X-Output-Format",

    "X-PDF-Pages",
    "X-PDF-DPI",
    "X-PDF-JPEG-QUALITY"
  ]
}));

app.use(express.json({
  limit: "10mb"
}));

// =====================================
// REQUEST LOGGER
// =====================================

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}]`,
    req.method,
    req.originalUrl
  );

  next();
});

// =====================================
// IMAGE MULTER CONFIGURATION
// =====================================

const imageUpload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1
  },

  fileFilter(req, file, cb) {
    const allowedTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/bmp",
      "image/tiff"
    ]);

    if (!allowedTypes.has(file.mimetype)) {
      return cb(
        new Error(
          "Only JPG, PNG, WEBP, BMP and TIFF images are supported."
        )
      );
    }

    cb(null, true);
  }
});

// =====================================
// IMAGE PROCESSING FUNCTION
// =====================================

async function processImage(file, body) {
  if (!file) {
    throw new Error("Please select an image.");
  }

  const action = String(body.action || "");

  if (!["compress", "resize", "enhance", "rotate"].includes(action)) {
    throw new Error("Unsupported image operation.");
  }

  const rawQuality = Number(body.quality ?? 75);

  if (!Number.isFinite(rawQuality)) {
    throw new Error("Invalid image quality.");
  }

  const quality = Math.max(10, Math.min(100, rawQuality));

  let image = sharp(file.buffer, {
    limitInputPixels: 40000000,
    failOn: "error"
  });

  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new Error("Invalid image file.");
  }

  // RESIZE
  if (action === "resize") {
    const width = Number(body.width);
    const height = Number(body.height);

    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 10000 ||
      height > 10000
    ) {
      throw new Error("Enter valid image width and height.");
    }

    image = image.resize(width, height, {
      fit: "fill"
    });
  }

  // ROTATE
  if (action === "rotate") {
    const angle = Number(body.rotation ?? 0);

    if (!Number.isFinite(angle) || Math.abs(angle) > 3600) {
      throw new Error("Invalid rotation angle.");
    }

    image = image.rotate(angle);
  }

  // ENHANCE
  if (action === "enhance") {
    const strength = quality / 100;

    image = image
      .modulate({
        brightness: 1 + strength * 0.12,
        saturation: 1 + strength * 0.15
      })
      .sharpen();
  }

  // OUTPUT
  let output;
  let contentType;
  let extension;

  if (metadata.format === "png") {
    output = await image.png({
      compressionLevel: 9,
      adaptiveFiltering: true
    }).toBuffer();

    contentType = "image/png";
    extension = "png";

  } else if (metadata.format === "webp") {
    output = await image.webp({
      quality: action === "compress" ? quality : 90,
      effort: 6
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

  const outputMetadata = await sharp(output).metadata();

  const originalSize = file.buffer.length;
  const processedSize = output.length;

  const compressionPercent = Number(
    ((1 - processedSize / originalSize) * 100).toFixed(2)
  );

  return {
    output,
    contentType,
    extension,
    originalSize,
    processedSize,
    compressionPercent,
    width: outputMetadata.width,
    height: outputMetadata.height
  };
}

// =====================================
// IMAGE RESPONSE
// =====================================

function sendImageResult(res, result, mode) {
  res.setHeader("Content-Type", result.contentType);

  res.setHeader("X-Original-Size", String(result.originalSize));
  res.setHeader("X-Processed-Size", String(result.processedSize));
  res.setHeader("X-Compression-Percent", String(result.compressionPercent));

  res.setHeader("X-Output-Width", String(result.width));
  res.setHeader("X-Output-Height", String(result.height));
  res.setHeader("X-Output-Format", result.extension);

  res.setHeader("Cache-Control", "no-store");

  const filename = mode === "preview"
    ? `docufix-preview.${result.extension}`
    : `docufix-edited.${result.extension}`;

  res.setHeader(
    "Content-Disposition",
    `${mode === "preview" ? "inline" : "attachment"}; filename="${filename}"`
  );

  return res.send(result.output);
}

// =====================================
// IMAGE PREVIEW API
// =====================================

app.post(
  "/api/image/preview",
  imageUpload.single("file"),
  async (req, res) => {
    try {
      console.log("IMAGE PREVIEW HIT");

      const result = await processImage(req.file, req.body);

      return sendImageResult(res, result, "preview");

    } catch (error) {
      console.error("Image preview error:", error);

      if (!res.headersSent) {
        return res.status(400).json({
          success: false,
          message: error.message || "Image preview failed."
        });
      }
    }
  }
);

// =====================================
// IMAGE PROCESS API
// =====================================

app.post(
  "/api/image/process",
  imageUpload.single("file"),
  async (req, res) => {
    try {
      console.log("IMAGE PROCESS HIT");

      const result = await processImage(req.file, req.body);

      return sendImageResult(res, result, "process");

    } catch (error) {
      console.error("Image processing error:", error);

      if (!res.headersSent) {
        return res.status(400).json({
          success: false,
          message: error.message || "Image processing failed."
        });
      }
    }
  }
);

// =====================================
// PDF ROUTES
// =====================================

app.use("/api/pdf", pdfRoutes);

// =====================================
// HEALTH CHECK
// =====================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "DocuFix Backend Running",
    hosting: "Render",

    image: [
      "POST /api/image/preview",
      "POST /api/image/process"
    ],

    pdf: [
      "POST /api/pdf/preview",
      "POST /api/pdf/process"
    ]
  });
});

// =====================================
// 404 HANDLER
// =====================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
    method: req.method,
    path: req.originalUrl
  });
});

// =====================================
// GLOBAL ERROR HANDLER
// =====================================

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

  if (res.headersSent) {
    return next(err);
  }

  const statusCode =
    err instanceof multer.MulterError ? 400 :
    err.message === "Not allowed by CORS" ? 403 :
    500;

  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal server error."
  });
});

// =====================================
// START SERVER
// =====================================

app.listen(PORT, HOST, () => {
  console.log("--------------------------------");
  console.log("       DOCUFIX BACKEND");
  console.log("--------------------------------");

  console.log(`Host: ${HOST}`);
  console.log(`Port: ${PORT}`);
  console.log("Hosting: Render");

  console.log("Image preview: /api/image/preview");
  console.log("Image process: /api/image/process");

  console.log("PDF preview: /api/pdf/preview");
  console.log("PDF process: /api/pdf/process");

  console.log("--------------------------------");
  console.log("Server is ready!");
});
