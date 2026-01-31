import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, Printer, Share2, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export default function ScreenshotShareModal({ isOpen, onClose, imageDataUrl, filename = 'screenshot.png' }) {
  const [isSharing, setIsSharing] = useState(false);

  const handleDownload = () => {
    if (!imageDataUrl) return;

    const link = document.createElement('a');
    link.href = imageDataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Screenshot downloaded');
  };

  const handlePrint = () => {
    if (!imageDataUrl) return;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html>
        <head>
          <title>Print Screenshot</title>
          <style>
            body { margin: 0; display: flex; justify-content: center; align-items: center; }
            img { max-width: 100%; height: auto; }
          </style>
        </head>
        <body>
          <img src="${imageDataUrl}" onload="window.print(); window.close();" />
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const handleShare = async () => {
    if (!imageDataUrl) return;

    setIsSharing(true);

    try {
      // Convert data URL to blob
      const response = await fetch(imageDataUrl);
      const blob = await response.blob();
      const file = new File([blob], filename, { type: 'image/png' });

      // Check if Web Share API is supported
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Screenshot',
          text: 'Check out this screenshot'
        });
        toast.success('Shared successfully');
      } else {
        // Fallback: just download if sharing isn't supported
        toast.info('Sharing not supported - downloading instead');
        handleDownload();
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Share error:', error);
        toast.error('Failed to share');
      }
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Screenshot Preview</span>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </DialogTitle>
        </DialogHeader>

        {/* Screenshot Preview */}
        <div className="overflow-auto max-h-[60vh] border rounded-lg bg-slate-50">
          {imageDataUrl ? (
            <img 
              src={imageDataUrl} 
              alt="Screenshot preview" 
              className="w-full h-auto"
            />
          ) : (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          )}
        </div>

        <DialogFooter className="flex-row gap-2 justify-end">
          <Button variant="outline" onClick={handleDownload} className="gap-2">
            <Download className="w-4 h-4" />
            Save
          </Button>
          <Button variant="outline" onClick={handlePrint} className="gap-2">
            <Printer className="w-4 h-4" />
            Print
          </Button>
          <Button 
            onClick={handleShare} 
            disabled={isSharing}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700"
          >
            {isSharing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Share2 className="w-4 h-4" />
            )}
            Share
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}