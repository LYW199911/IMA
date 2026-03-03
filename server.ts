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
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
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
    const outputFormat = (req.body.outputFormat as string) || "txt"; // 'txt' or 'pdf'

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    // 1. Extract and combine text
    let combinedText = "";
    for (const file of files) {
      const text = await extractText(file.path, file.mimetype);
      combinedText += text + "\n\n";
      // Cleanup
      fs.unlinkSync(file.path);
    }

    // 2. Check character limit (500,000)
    if (combinedText.length > 500000) {
      return res.status(400).json({ error: "Total character count exceeds 500,000 limit." });
    }

    // 3. Prepare Folder Path
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, "0");
    const day = now.getDate().toString().padStart(2, "0");
    const folderPath = ["IMA", year, month, day];
    const folderId = await ensureFolder(drive, folderPath);

    // 4. Check for existing file for today
    const fileName = `${year}-${month}-${day}.${outputFormat}`;
    const existingFiles = await drive.files.list({
      q: `name = '${fileName}' and '${folderId}' in parents and trashed = false`,
      fields: "files(id, size)",
    });

    let finalContent: string | Buffer = combinedText;
    let fileId: string | null = null;

    if (existingFiles.data.files.length > 0) {
      fileId = existingFiles.data.files[0].id;
      // Append logic
      if (outputFormat === "txt") {
        const existingRes = await drive.files.get({ fileId, alt: "media" });
        finalContent = (existingRes.data as string) + "\n" + combinedText;
      } else {
        // For PDF, we extract text from existing PDF, append, and recreate
        const existingRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
        const parser = new PDFParse({ data: Buffer.from(existingRes.data as any) });
        const existingData = await parser.getText();
        await parser.destroy();
        finalContent = existingData.text + "\n" + combinedText;
      }
    }

    // Re-check limit after append
    if (finalContent.length > 500000) {
      return res.status(400).json({ error: "Appending would exceed the 500,000 character limit." });
    }

    // 5. Create/Update File
    let media: any;
    if (outputFormat === "pdf") {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.registerFontkit(fontkit);

      // Fetch a font that supports CJK characters (Noto Sans SC)
      const fontUrl = 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf';
      let fontBytes;
      try {
        const fontRes = await fetch(fontUrl);
        if (!fontRes.ok) {
          throw new Error(`Failed to fetch font: ${fontRes.status} ${fontRes.statusText}`);
        }
        fontBytes = await fontRes.arrayBuffer();
      } catch (e) {
        console.error("Failed to fetch CJK font, falling back to basic font", e);
        throw new Error("Failed to load CJK font for PDF generation.");
      }

      const customFont = await pdfDoc.embedFont(fontBytes);

      let page = pdfDoc.addPage();
      const { width, height } = page.getSize();
      const fontSize = 12;

      // Basic text wrapping for PDF (very simple implementation)
      const lines = (finalContent as string).split("\n");
      let y = height - 50;
      for (const line of lines) {
        if (y < 50) {
          page = pdfDoc.addPage();
          y = height - 50;
        }
        page.drawText(line.substring(0, 80), { x: 50, y, size: fontSize, font: customFont });
        y -= fontSize + 2;
      }
      const pdfBytes = await pdfDoc.save();
      media = {
        mimeType: "application/pdf",
        body: Buffer.from(pdfBytes),
      };
    } else {
      media = {
        mimeType: "text/plain",
        body: finalContent,
      };
    }

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
