import React, { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

const SettingsField: React.FC<{
  label: string
  children: React.ReactNode
  description?: string
}> = ({ label, children, description }) => (
  <div className="space-y-2">
    <Label className="text-sm font-medium text-foreground">{label}</Label>
    {children}
    {description && (
      <p className="text-sm text-muted-foreground">{description}</p>
    )}
  </div>
)

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    <div className="space-y-4">{children}</div>
  </div>
)

export const AdvancedPane: React.FC = () => {
  // LLM options
  const llmOptions = [
    { value: 'lfm', label: 'LFM' },
    { value: 'gpt-oss', label: 'GPT-OSS' },
    { value: 'gemma3', label: 'Gemma3' },
  ]

  const [selectedLLM, setSelectedLLM] = useState('lfm')
  const [showDownloadDialog, setShowDownloadDialog] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set(['lfm']))

  const handleLLMChange = (value: string) => {
    // Check if model is already downloaded
    if (downloadedModels.has(value)) {
      setSelectedLLM(value)
    } else {
      // Show download dialog
      setSelectedLLM(value)
      setShowDownloadDialog(true)
    }
  }

  const handleDownload = () => {
    setIsDownloading(true)
    setDownloadProgress(0)
    
    // Simulate download progress
    const interval = setInterval(() => {
      setDownloadProgress(prev => {
        const newProgress = prev + 10
        if (newProgress >= 100) {
          clearInterval(interval)
          // After download completes
          setTimeout(() => {
            setIsDownloading(false)
            setDownloadedModels(prev => new Set(prev).add(selectedLLM))
            setShowDownloadDialog(false)
          }, 500)
          return 100
        }
        return newProgress
      })
    }, 300)
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="AI Model Settings">
        <SettingsField
          label="Select LLM"
          description="Choose the language model for AI features"
        >
          <Select value={selectedLLM} onValueChange={handleLLMChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select LLM" />
            </SelectTrigger>
            <SelectContent>
              {llmOptions.map((llm) => (
                <SelectItem key={llm.value} value={llm.value}>
                  {llm.label} {downloadedModels.has(llm.value) ? '✓' : '↓'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>
      </SettingsSection>

      {/* Download Dialog */}
      <Dialog open={showDownloadDialog} onOpenChange={setShowDownloadDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Download Model</DialogTitle>
            <DialogDescription>
              The selected model needs to be downloaded before use.
            </DialogDescription>
          </DialogHeader>
          
          {isDownloading ? (
            <div className="space-y-4">
              <p>Downloading {llmOptions.find(llm => llm.value === selectedLLM)?.label}...</p>
              <Progress value={downloadProgress} />
              <p className="text-sm text-muted-foreground text-center">
                {downloadProgress}% complete
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <p>
                Would you like to download the {llmOptions.find(llm => llm.value === selectedLLM)?.label} model?
              </p>
              <div className="flex justify-end space-x-2">
                <Button 
                  variant="outline" 
                  onClick={() => setShowDownloadDialog(false)}
                >
                  Cancel
                </Button>
                <Button onClick={handleDownload}>
                  Download
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}