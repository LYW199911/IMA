import React, { useState, useEffect, useCallback } from "react";
import { 
  Upload, 
  FileText, 
  CheckCircle, 
  AlertCircle, 
  Loader2, 
  Plus, 
  X, 
  FileUp,
  Settings2,
  ExternalLink,
  History
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string; details?: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    checkAuth();
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "oauth_success" && event.newValue === "true") {
        setIsAuthenticated(true);
        localStorage.removeItem("oauth_success");
      }
    };
    window.addEventListener("storage", handleStorage);
    
    // Also keep message listener as fallback
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        setIsAuthenticated(true);
      }
    };
    window.addEventListener("message", handleMessage);
    
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  const checkAuth = async () => {
    try {
      const res = await fetch("/api/auth/status");
      const data = await res.json();
      setIsAuthenticated(data.isAuthenticated);
    } catch (err) {
      console.error("Failed to check auth status", err);
      setIsAuthenticated(false);
    }
  };

  const handleConnect = async () => {
    try {
      const res = await fetch("/api/auth/url");
      const { url } = await res.json();
      // Use noopener to prevent cross-origin frame access errors from third-party scripts
      window.open(url, "google_auth", "width=600,height=700,noopener");
    } catch (err) {
      console.error("Failed to get auth URL", err);
    }
  };

  const onDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const newFiles = Array.from(e.dataTransfer.files);
      setFiles(prev => [...prev, ...newFiles]);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const newFiles = Array.from(e.target.files);
      setFiles(prev => [...prev, ...newFiles]);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleMerge = async () => {
    if (files.length === 0) return;
    setIsUploading(true);
    setStatus(null);

    const formData = new FormData();
    files.forEach(file => formData.append("files", file));

    try {
      const res = await fetch("/api/merge", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setStatus({ type: "success", message: `Successfully merged and saved to: ${data.path}` });
        setFiles([]);
      } else {
        setStatus({ 
          type: "error", 
          message: data.error || "Failed to merge files.",
          details: data.details
        });
      }
    } catch (err: any) {
      setStatus({ 
        type: "error", 
        message: "An unexpected error occurred.",
        details: err.message || String(err)
      });
    } finally {
      setIsUploading(false);
    }
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-[#FDFCFB] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-stone-900 font-sans selection:bg-stone-200">
      <header className="max-w-4xl mx-auto pt-20 pb-12 px-6">
        <div className="flex items-center justify-between mb-2">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3"
          >
            <div className="w-10 h-10 bg-stone-900 rounded-xl flex items-center justify-center text-white">
              <FileUp size={20} />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">IMA File Merger</h1>
          </motion.div>
          {isAuthenticated && (
            <div className="flex items-center gap-2 text-xs font-medium text-stone-400 uppercase tracking-widest">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              Connected to Drive
            </div>
          )}
        </div>
        <p className="text-stone-500 font-serif italic">
          Merge PDF, DOCX, and TXT files seamlessly into your Google Drive.
        </p>
      </header>

      <main className="max-w-4xl mx-auto px-6 pb-24">
        {!isAuthenticated ? (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white border border-stone-200 rounded-3xl p-12 text-center shadow-sm"
          >
            <div className="w-16 h-16 bg-stone-50 rounded-full flex items-center justify-center mx-auto mb-6">
              <Settings2 className="text-stone-400" />
            </div>
            <h2 className="text-xl font-medium mb-2">Connect your Google Drive</h2>
            <p className="text-stone-500 mb-8 max-w-sm mx-auto">
              We need access to your Google Drive to create folders and save your merged files.
            </p>
            <button 
              onClick={handleConnect}
              className="bg-stone-900 text-white px-8 py-3 rounded-full font-medium hover:bg-stone-800 transition-colors inline-flex items-center gap-2"
            >
              Connect Now
              <ExternalLink size={16} />
            </button>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="md:col-span-2 space-y-6">
              {/* Upload Area */}
              <div 
                onDragEnter={onDrag}
                onDragLeave={onDrag}
                onDragOver={onDrag}
                onDrop={onDrop}
                className={`relative border-2 border-dashed rounded-3xl p-12 transition-all duration-300 flex flex-col items-center justify-center gap-4 ${
                  dragActive ? "border-stone-900 bg-stone-50" : "border-stone-200 bg-white"
                }`}
              >
                <input 
                  type="file" 
                  multiple 
                  onChange={handleFileChange}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  accept=".pdf,.docx,.txt"
                />
                <div className="w-12 h-12 bg-stone-50 rounded-2xl flex items-center justify-center text-stone-400">
                  <Upload size={24} />
                </div>
                <div className="text-center">
                  <p className="font-medium">Click to upload or drag and drop</p>
                  <p className="text-sm text-stone-400 mt-1">PDF, DOCX, or TXT (Max 500k chars)</p>
                </div>
              </div>

              {/* File List */}
              <AnimatePresence mode="popLayout">
                {files.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-2"
                  >
                    <div className="flex items-center justify-between px-2">
                      <h3 className="text-xs font-bold text-stone-400 uppercase tracking-widest">Files to Merge</h3>
                      <button 
                        onClick={() => setFiles([])}
                        className="text-xs text-stone-400 hover:text-stone-900"
                      >
                        Clear All
                      </button>
                    </div>
                    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden divide-y divide-stone-100">
                      {files.map((file, idx) => (
                        <motion.div 
                          key={`${file.name}-${idx}`}
                          layout
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="flex items-center justify-between p-4 group"
                        >
                          <div className="flex items-center gap-3">
                            <FileText size={18} className="text-stone-400" />
                            <div>
                              <p className="text-sm font-medium truncate max-w-[200px]">{file.name}</p>
                              <p className="text-xs text-stone-400">{(file.size / 1024).toFixed(1)} KB</p>
                            </div>
                          </div>
                          <button 
                            onClick={() => removeFile(idx)}
                            className="p-2 text-stone-300 hover:text-red-500 transition-colors"
                          >
                            <X size={16} />
                          </button>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="space-y-6">
              {/* Settings */}
              <div className="bg-white border border-stone-200 rounded-3xl p-6 shadow-sm">
                <h3 className="text-sm font-bold text-stone-400 uppercase tracking-widest mb-6">Settings</h3>
                
                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-medium text-stone-500 mb-2 block">Output Format</label>
                    <div className="bg-stone-50 border border-stone-100 rounded-xl p-4">
                      <p className="text-sm text-stone-700 font-medium">PDF Document</p>
                      <p className="text-xs text-stone-500 mt-1">
                        All files will be merged into a single PDF. Existing PDFs are appended directly, while text and DOCX files are converted automatically.
                      </p>
                    </div>
                  </div>

                  <div className="pt-4">
                    <button 
                      onClick={handleMerge}
                      disabled={files.length === 0 || isUploading}
                      className={`w-full py-4 rounded-2xl font-semibold flex items-center justify-center gap-2 transition-all ${
                        files.length === 0 || isUploading
                          ? "bg-stone-100 text-stone-400 cursor-not-allowed"
                          : "bg-stone-900 text-white hover:bg-stone-800 shadow-lg active:scale-[0.98]"
                      }`}
                    >
                      {isUploading ? (
                        <>
                          <Loader2 size={18} className="animate-spin" />
                          Merging...
                        </>
                      ) : (
                        <>
                          <Plus size={18} />
                          Merge & Save
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Status Messages */}
              <AnimatePresence>
                {status && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className={`p-4 rounded-2xl flex gap-3 ${
                      status.type === "success" 
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-100" 
                        : "bg-red-50 text-red-700 border border-red-100"
                    }`}
                  >
                    {status.type === "success" ? <CheckCircle size={18} className="shrink-0 mt-0.5" /> : <AlertCircle size={18} className="shrink-0 mt-0.5" />}
                    <div className="flex-1">
                      <p className="text-sm font-medium leading-tight">{status.message}</p>
                      {status.details && (
                        <div className="mt-2 p-2 bg-white/50 rounded-lg border border-red-200/50">
                          <p className="text-xs font-mono break-all text-red-800/80">{status.details}</p>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Info Card */}
              <div className="bg-stone-50 rounded-3xl p-6 border border-stone-100">
                <div className="flex items-center gap-2 mb-3">
                  <History size={16} className="text-stone-400" />
                  <h4 className="text-xs font-bold text-stone-400 uppercase tracking-widest">Automation</h4>
                </div>
                <p className="text-xs text-stone-500 leading-relaxed">
                  Files are automatically saved to <code className="bg-stone-200 px-1 rounded">IMA/YYYY/MM/DD</code>. 
                  If a file exists for today, new content will be appended.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
