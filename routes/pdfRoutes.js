
const express = require("express");
const multer = require("multer");
const { PDFDocument, degrees } = require("pdf-lib");

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const router = express.Router();

// =====================================
// CONFIGURATION
// =====================================

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_PAGES = 100;
const MINIMUM_SAVING_BYTES = 0;

const GS_BIN =
  process.env.GS_BIN ||
  (process.platform === "win32" ? "gswin64c" : "gs");

// =====================================
// MULTER
// =====================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },

  fileFilter(req, file, cb) {
    const isPDF =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");

    if (!isPDF) {
      return cb(new Error("Only PDF files are supported."));
    }

    cb(null, true);
  }
});

// =====================================
// VALIDATION
// =====================================

function validateQuality(value) {
  const raw = Number(value ?? 75);

  if (!Number.isFinite(raw)) {
    throw new Error("Invalid compression level.");
  }

  return Math.max(10, Math.min(100, Math.round(raw)));
}

function validateRotation(value) {
  const angle = Number(value ?? 0);

  if (
    !Number.isFinite(angle) ||
    angle % 90 !== 0 ||
    Math.abs(angle) > 3600
  ) {
    throw new Error(
      "Rotation must be a multiple of 90 degrees."
    );
  }

  return ((angle % 360) + 360) % 360;
}

// =====================================
// QUALITY SETTINGS
// Higher quality = less compression
// Lower quality = more compression
// =====================================

function getCompressionSettings(quality) {
  const q = validateQuality(quality);

  // Slider: 10 - 100
  // Quality 10  = Strong compression
  // Quality 50  = Balanced compression
  // Quality 75  = Good quality
  // Quality 100 = High quality

  const dpi = Math.round(
    72 + ((q - 10) / 90) * 228
  );

  const jpegQuality = Math.round(
    40 + ((q - 10) / 90) * 55
  );

  return {
    dpi,
    jpegQuality
  };
}

// =====================================
// CHECK PDF PAGE COUNT
// =====================================

async function getPDFPageCount(fileBuffer) {
  const pdf = await PDFDocument.load(fileBuffer, {
    updateMetadata: false
  });

  const pageCount = pdf.getPageCount();

  if (pageCount < 1) {
    throw new Error("The PDF contains no pages.");
  }

  if (pageCount > MAX_PAGES) {
    throw new Error(
      `Maximum ${MAX_PAGES} pages are supported.`
    );
  }

  return pageCount;
}

// =====================================
// GHOSTSCRIPT COMPRESSION
// =====================================

async function compressPDF(fileBuffer, quality) {
  const settings = getCompressionSettings(quality);

  const originalSize = fileBuffer.length;

  const pageCount = await getPDFPageCount(fileBuffer);

  const tempDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "docufix-pdf-")
  );

  const inputPath = path.join(
    tempDirectory,
    "original.pdf"
  );

  const outputPath = path.join(
    tempDirectory,
    "compressed.pdf"
  );

  try {
    // =====================================
    // WRITE INPUT PDF
    // =====================================

    await fs.promises.writeFile(
      inputPath,
      fileBuffer
    );

    // =====================================
    // GHOSTSCRIPT ARGUMENTS
    // =====================================

    const args = [
      "-sDEVICE=pdfwrite",

      "-dCompatibilityLevel=1.5",

      "-dNOPAUSE",
      "-dBATCH",
      "-dQUIET",
      "-dSAFER",

      // PDF optimization
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dCompressPages=true",

      // Recompress embedded images
      "-dPassThroughJPEGImages=false",
      "-dPassThroughJPXImages=false",

      // Color image settings
      "-dDownsampleColorImages=true",
      "-dColorImageDownsampleType=/Bicubic",
      `-dColorImageResolution=${settings.dpi}`,
      "-dColorImageDownsampleThreshold=1.0",
      "-dAutoFilterColorImages=false",
      "-dColorImageFilter=/DCTEncode",

      // Grayscale image settings
      "-dDownsampleGrayImages=true",
      "-dGrayImageDownsampleType=/Bicubic",
      `-dGrayImageResolution=${settings.dpi}`,
      "-dGrayImageDownsampleThreshold=1.0",
      "-dAutoFilterGrayImages=false",
      "-dGrayImageFilter=/DCTEncode",

      // Monochrome image settings
      "-dDownsampleMonoImages=true",
      "-dMonoImageDownsampleType=/Subsample",
      `-dMonoImageResolution=${Math.max(150, settings.dpi)}`,
      "-dMonoImageDownsampleThreshold=1.0",

      // JPEG quality
      `-dJPEGQ=${settings.jpegQuality}`,

      // Output
      `-sOutputFile=${outputPath}`,

      inputPath
    ];

    console.log("--------------------------------");
    console.log("DOCUFIX GHOSTSCRIPT COMPRESSION");
    console.log("Quality:", quality);
    console.log("DPI:", settings.dpi);
    console.log("JPEG Quality:", settings.jpegQuality);
    console.log("Original Size:", originalSize);
    console.log("--------------------------------");

    // =====================================
    // EXECUTE GHOSTSCRIPT
    // =====================================

    await execFileAsync(
      GS_BIN,
      args,
      {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
      }
    );

    // =====================================
    // CHECK OUTPUT
    // =====================================

    const outputExists = await fs.promises.access(
      outputPath,
      fs.constants.F_OK
    ).then(() => true).catch(() => false);

    if (!outputExists) {
      throw new Error(
        "Ghostscript did not generate an output PDF."
      );
    }

    const compressedBuffer = await fs.promises.readFile(
      outputPath
    );

    if (
      compressedBuffer.length < 5 ||
      compressedBuffer.subarray(0, 5).toString() !== "%PDF-"
    ) {
      throw new Error(
        "Ghostscript generated an invalid PDF."
      );
    }

    const compressedSize = compressedBuffer.length;

    const savedBytes = Math.max(
      0,
      originalSize - compressedSize
    );

    const savedPercentage = originalSize > 0
      ? (savedBytes / originalSize) * 100
      : 0;

    console.log("--------------------------------");
    console.log("COMPRESSION RESULT");
    console.log("Original:", originalSize, "bytes");
    console.log("Compressed:", compressedSize, "bytes");
    console.log("Saved:", savedBytes, "bytes");
    console.log("Reduction:", savedPercentage.toFixed(2) + "%");
    console.log("--------------------------------");

    // =====================================
    // RETURN ORIGINAL IF NOT SMALLER
    // =====================================

    if (
      compressedSize >= originalSize ||
      savedBytes <= MINIMUM_SAVING_BYTES
    ) {
      console.log(
        "No size reduction. Returning original PDF."
      );

      return {
        output: fileBuffer,
        pageCount,
        settings: null,
        compressionApplied: false
      };
    }

    // =====================================
    // RETURN COMPRESSED PDF
    // =====================================

    console.log("Ghostscript compression successful.");

    return {
      output: compressedBuffer,
      pageCount,
      settings,
      compressionApplied: true
    };

  } catch (error) {
    if (
      error.code === "ENOENT" ||
      error.code === "ENOENT"
    ) {
      throw new Error(
        "Ghostscript is not installed or its executable was not found. Install Ghostscript and configure GS_BIN."
      );
    }

    if (error.killed) {
      throw new Error(
        "PDF compression timed out. Try a smaller PDF."
      );
    }

    console.error(
      "Ghostscript error:",
      error.stderr || error.message
    );

    throw new Error(
      error.stderr
        ? `PDF compression failed: ${String(error.stderr).slice(0, 500)}`
        : error.message || "PDF compression failed."
    );

  } finally {
    // =====================================
    // CLEAN TEMPORARY FILES
    // =====================================

    await fs.promises.rm(tempDirectory, {
      recursive: true,
      force: true
    }).catch(error => {
      console.error(
        "Temporary directory cleanup error:",
        error.message
      );
    });
  }
}

// =====================================
// ROTATE PDF
// =====================================

async function rotatePDF(fileBuffer, rotation) {
  const pdf = await PDFDocument.load(fileBuffer, {
    updateMetadata: false
  });

  const normalizedAngle = validateRotation(rotation);

  pdf.getPages().forEach(page => {
    const currentAngle = page.getRotation().angle;

    page.setRotation(
      degrees((currentAngle + normalizedAngle) % 360)
    );
  });

  const savedPDF = await pdf.save({
    useObjectStreams: true,
    addDefaultPage: false
  });

  return {
    output: Buffer.from(savedPDF),
    pageCount: pdf.getPageCount()
  };
}

// =====================================
// PROCESS PDF
// =====================================

async function processPDF(file, body) {
  if (!file) {
    throw new Error("Please select a PDF file.");
  }

  const action = String(body.action || "");

  if (!["compress", "rotate"].includes(action)) {
    throw new Error("Unsupported PDF operation.");
  }

  const originalSize = file.buffer.length;

  let output;
  let pageCount;
  let settings = null;
  let compressionApplied = false;

  // =====================================
  // COMPRESS
  // =====================================

  if (action === "compress") {
    const quality = validateQuality(body.quality);

    const result = await compressPDF(
      file.buffer,
      quality
    );

    output = result.output;
    pageCount = result.pageCount;
    settings = result.settings;
    compressionApplied = result.compressionApplied;
  }

  // =====================================
  // ROTATE
  // =====================================

  if (action === "rotate") {
    const result = await rotatePDF(
      file.buffer,
      body.rotation
    );

    output = result.output;
    pageCount = result.pageCount;
  }

  // =====================================
  // SIZE CALCULATION
  // =====================================

  const processedSize = output.length;

  const savedBytes = Math.max(
    0,
    originalSize - processedSize
  );

  const sizeDifference = originalSize > 0
    ? Number(
        ((savedBytes / originalSize) * 100).toFixed(2)
      )
    : 0;

  const sizeChangePercent = originalSize > 0
    ? Number(
        (
          ((processedSize - originalSize) / originalSize) *
          100
        ).toFixed(2)
      )
    : 0;

  return {
    output,
    originalSize,
    processedSize,
    savedBytes,
    sizeDifference,
    sizeChangePercent,
    pageCount,
    settings,
    compressionApplied
  };
}

// =====================================
// RESPONSE HEADERS
// =====================================

function setPDFHeaders(res, result) {
  res.setHeader(
    "Content-Type",
    "application/pdf"
  );

  res.setHeader(
    "X-Original-Size",
    String(result.originalSize)
  );

  res.setHeader(
    "X-Processed-Size",
    String(result.processedSize)
  );

  res.setHeader(
    "X-Saved-Size",
    String(result.savedBytes)
  );

  res.setHeader(
    "X-Compression-Percent",
    String(result.sizeDifference)
  );

  res.setHeader(
    "X-Size-Change-Percent",
    String(result.sizeChangePercent)
  );

  res.setHeader(
    "X-PDF-Pages",
    String(result.pageCount)
  );

  res.setHeader(
    "X-Compression-Applied",
    String(result.compressionApplied)
  );

  if (result.settings) {
    res.setHeader(
      "X-PDF-DPI",
      String(result.settings.dpi)
    );

    res.setHeader(
      "X-PDF-JPEG-QUALITY",
      String(result.settings.jpegQuality)
    );
  }

  res.setHeader(
    "Cache-Control",
    "no-store"
  );
}

// =====================================
// ERROR HANDLER
// =====================================

function handlePDFError(res, error, label) {
  console.error(`${label}:`, error);

  if (res.headersSent) {
    return res.end();
  }

  return res.status(400).json({
    success: false,
    message: error.message || `${label} failed.`
  });
}

// =====================================
// PREVIEW API
// =====================================

router.post(
  "/preview",
  upload.single("file"),
  async (req, res) => {
    try {
      console.log("PDF PREVIEW HIT");

      const result = await processPDF(
        req.file,
        req.body
      );

      setPDFHeaders(res, result);

      res.setHeader(
        "Content-Disposition",
        'inline; filename="docufix-preview.pdf"'
      );

      return res.send(result.output);

    } catch (error) {
      return handlePDFError(
        res,
        error,
        "PDF preview error"
      );
    }
  }
);

// =====================================
// PROCESS API
// =====================================

router.post(
  "/process",
  upload.single("file"),
  async (req, res) => {
    try {
      console.log("PDF PROCESS HIT");

      const result = await processPDF(
        req.file,
        req.body
      );

      setPDFHeaders(res, result);

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="docufix-edited.pdf"'
      );

      return res.send(result.output);

    } catch (error) {
      return handlePDFError(
        res,
        error,
        "PDF processing error"
      );
    }
  }
);

module.exports = router;
