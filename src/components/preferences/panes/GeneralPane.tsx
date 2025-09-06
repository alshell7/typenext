import React, { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'

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

export const GeneralPane: React.FC = () => {
  // Font options
  const fontOptions = [
    { value: 'inter', label: 'Inter' },
    { value: 'roboto', label: 'Roboto' },
    { value: 'open-sans', label: 'Open Sans' },
    { value: 'lato', label: 'Lato' },
    { value: 'montserrat', label: 'Montserrat' },
  ]

  // Copilot language options
  const copilotLanguages = [
    { value: 'typescript', label: 'TypeScript' },
    { value: 'javascript', label: 'JavaScript' },
    { value: 'python', label: 'Python' },
    { value: 'rust', label: 'Rust' },
    { value: 'go', label: 'Go' },
  ]

  const [selectedFont, setSelectedFont] = useState('inter')
  const [selectedCopilotLanguage, setSelectedCopilotLanguage] = useState('typescript')
  const [autosaveNotes, setAutosaveNotes] = useState(true)

  return (
    <div className="space-y-6">
      <SettingsSection title="Editor Settings">
        <SettingsField
          label="Editor Font"
          description="Choose your preferred font for the editor"
        >
          <Select value={selectedFont} onValueChange={setSelectedFont}>
            <SelectTrigger>
              <SelectValue placeholder="Select font" />
            </SelectTrigger>
            <SelectContent>
              {fontOptions.map((font) => (
                <SelectItem key={font.value} value={font.value}>
                  {font.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>

        <SettingsField
          label="Default Copilot Language"
          description="Set the default language for AI assistance"
        >
          <Select 
            value={selectedCopilotLanguage} 
            onValueChange={setSelectedCopilotLanguage}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select language" />
            </SelectTrigger>
            <SelectContent>
              {copilotLanguages.map((language) => (
                <SelectItem key={language.value} value={language.value}>
                  {language.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>

        <SettingsField
          label="Autosave Notes"
          description="Automatically save your notes as you type"
        >
          <div className="flex items-center space-x-2">
            <Switch
              id="autosave-notes"
              checked={autosaveNotes}
              onCheckedChange={setAutosaveNotes}
            />
            <Label htmlFor="autosave-notes" className="text-sm">
              {autosaveNotes ? 'Enabled' : 'Disabled'}
            </Label>
          </div>
        </SettingsField>
      </SettingsSection>
    </div>
  )
}