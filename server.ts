import express from "express";
import { createServer as createViteServer } from "vite";
import { google } from "googleapis";
import multer from "multer";
import session from "express-session";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import dotenv from "dotenv";
import { Readable } from "stream";

dotenv.config();

const app = express();
const PORT = 3000;
const upload = multer({ dest: "uploads/" });

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "ima-merger-secret",
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: true,
      sameSite: "none",
      httpOnly: true,
    },
  })
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.APP_URL}/auth/callback`
);

// Auth Routes
app.get("/api/auth/url", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive.readonly"],
    prompt: "consent",
  });
  res.json({ url });
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    // Store tokens in session or cookie
    // For simplicity in this demo, we'll use a cookie for the refresh token
    if (tokens.refresh_token) {
      res.cookie("google_refresh_token", tokens.refresh_token, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
      });
    }
    res.cookie("google_access_token", tokens.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });

    res.send(`
      <html>
        <body>
          <script>
            try {
              // Try localStorage first (works well with noopener)
              localStorage.setItem('oauth_success', 'true');
              
              // Fallback to postMessage if opener exists
              if (window.opener && window.opener !== window) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              }
              
              // Close the popup
              window.close();
            } catch (e) {
              // Fallback if blocked
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).send("Authentication failed");
  }
});

app.get("/api/auth/status", (req, res) => {
  const token = req.cookies.google_access_token;
  res.json({ isAuthenticated: !!token });
});

// Helper: Get Google Drive Client
async function getDriveClient(req: express.Request) {
  const accessToken = req.cookies.google_access_token;
  const refreshToken = req.cookies.google_refresh_token;

  if (!accessToken && !refreshToken) return null;

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/auth/callback`
  );

  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  return google.drive({ version: "v3", auth: client });
}

// Helper: Ensure Folder Exists
async function ensureFolder(drive: any, pathParts: string[]): Promise<string> {
  let parentId = "root";
  for (const part of pathParts) {
    const res = await drive.files.list({
      q: `name = '${part}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
      fields: "files(id)",
    });

    if (res.data.files.length > 0) {
      parentId = res.data.files[0].id;
    } else {
      const folderMetadata = {
        name: part,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      };
      const folder = await drive.files.create({
        resource: folderMetadata,
        fields: "id",
      });
      parentId = folder.data.id;
    }
  }
  return parentId;
}

// Helper: Extract Text
async function extractText(filePath: string, mimeType: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  if (mimeType === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    await parser.destroy();
    return data.text;
  } else if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } else if (mimeType.startsWith("text/")) {
    return buffer.toString("utf-8");
  }
  return "";
}

// Merge Route
app.post("/api/merge", upload.array("files"), async (req, res) => {
  try {
    const drive = await getDriveClient(req);
    if (!drive) return res.status(401).json({ error: "Not authenticated" });

    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    // 1. Prepare Folder Path
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, "0");
    const day = now.getDate().toString().padStart(2, "0");
    const folderPath = ["IMA", year, month, day];
    const folderId = await ensureFolder(drive, folderPath);

    // 2. Check for existing file for today
    const fileName = `${year}-${month}-${day}.pdf`;
    const existingFiles = await drive.files.list({
      q: `name = '${fileName}' and '${folderId}' in parents and trashed = false`,
      fields: "files(id, size)",
    });

    let fileId: string | null = null;
    if (existingFiles.data.files && existingFiles.data.files.length > 0) {
      fileId = existingFiles.data.files[0].id as string;
    }

    // 3. Initialize Master PDF
    const masterPdf = await PDFDocument.create();
    masterPdf.registerFontkit(fontkit);
    
    // Fetch a font that supports CJK characters (Noto Sans SC)
    const fontUrl = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf';
    let fontBytes;
    try {
      const fontRes = await fetch(fontUrl);
      if (!fontRes.ok) throw new Error(`HTTP error! status: ${fontRes.status}`);
      fontBytes = await fontRes.arrayBuffer();
    } catch (e) {
      console.error("Failed to fetch CJK font", e);
      throw new Error("Failed to load CJK font for PDF generation.");
    }
    const customFont = await masterPdf.embedFont(fontBytes);

    const addTextToPdf = (pdfDoc: PDFDocument, text: string, font: any) => {
      const lines = text.split("\n");
      let page = pdfDoc.addPage();
      const { height } = page.getSize();
      const fontSize = 12;
      let y = height - 50;
      for (const line of lines) {
        let currentLine = line;
        if (currentLine.length === 0) {
          y -= fontSize + 2;
          if (y < 50) {
            page = pdfDoc.addPage();
            y = height - 50;
          }
          continue;
        }
        while (currentLine.length > 0) {
          if (y < 50) {
            page = pdfDoc.addPage();
            y = height - 50;
          }
          const chunk = currentLine.substring(0, 80);
          page.drawText(chunk, { x: 50, y, size: fontSize, font });
          currentLine = currentLine.substring(80);
          y -= fontSize + 2;
        }
      }
    };

    // 4. Handle Existing File (Append)
    if (fileId) {
      const existingRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      try {
        const existingPdf = await PDFDocument.load(existingRes.data as ArrayBuffer);
        const copiedPages = await masterPdf.copyPages(existingPdf, existingPdf.getPageIndices());
        copiedPages.forEach((page) => masterPdf.addPage(page));
      } catch (e) {
        // If not a valid PDF, treat as text
        const existingText = Buffer.from(existingRes.data as ArrayBuffer).toString("utf-8");
        addTextToPdf(masterPdf, existingText, customFont);
      }
    }

    // 5. Process Uploaded Files
    let totalTextLength = 0;
    for (const file of files) {
      if (file.mimetype === "application/pdf") {
        try {
          const pdfBytes = fs.readFileSync(file.path);
          const pdf = await PDFDocument.load(pdfBytes);
          const copiedPages = await masterPdf.copyPages(pdf, pdf.getPageIndices());
          copiedPages.forEach((page) => masterPdf.addPage(page));
        } catch (e) {
          console.error("Failed to append PDF file", e);
          throw new Error(`Failed to process PDF file: ${file.originalname}`);
        }
      } else {
        let text = "";
        if (file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
          const result = await mammoth.extractRawText({ path: file.path });
          text = result.value;
        } else {
          text = await extractText(file.path, file.mimetype);
        }
        totalTextLength += text.length;
        if (totalTextLength > 500000) {
           throw new Error("Total character count for text files exceeds 500,000 limit.");
        }
        addTextToPdf(masterPdf, text, customFont);
      }
      // Cleanup
      fs.unlinkSync(file.path);
    }

    // 6. Create/Update File
    const finalPdfBytes = await masterPdf.save();
    const media = {
      mimeType: "application/pdf",
      body: Readable.from(Buffer.from(finalPdfBytes)),
    };

    if (fileId) {
      await drive.files.update({
        fileId,
        media,
      });
    } else {
      await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [folderId],
        },
        media,
      });
    }

    res.json({ success: true, path: folderPath.join("/") + "/" + fileName });
  } catch (error: any) {
    console.error("Merge error:", error);
    res.status(500).json({ 
      error: "Failed to merge and upload files.", 
      details: error.message || String(error)
    });
  }
});

// Vite middleware
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve("dist/index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
