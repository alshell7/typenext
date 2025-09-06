import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { 
  AlertDialog, 
  AlertDialogAction, 
  AlertDialogCancel, 
  AlertDialogContent, 
  AlertDialogDescription, 
  AlertDialogFooter, 
  AlertDialogHeader, 
  AlertDialogTitle 
} from '@/components/ui/alert-dialog'
import { PlusIcon, TrashIcon, CheckIcon, UploadIcon, MoreHorizontalIcon } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useContextStore } from '@/store/context-store'
// Add Dropzone import
import { Dropzone, DropzoneContent, DropzoneEmptyState } from '@/components/ui/shadcn-io/dropzone'
// Import Sheet components instead of Dialog
import { 
  Sheet, 
  SheetContent, 
  SheetHeader, 
  SheetTitle, 
  SheetFooter,
  SheetClose
} from '@/components/ui/sheet'
// Import ScrollArea component
import { ScrollArea } from '@/components/ui/scroll-area'
// Import DropdownMenu components
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
// Import Dialog components for view context
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Context {
  id: string
  title: string
  description: string | any // Allow both string and PlateJS Value format
  files: string[]
  isActive: boolean
}

interface RightSideBarProps {
  children?: React.ReactNode
  className?: string
}

// Add interface for context switch confirmation
interface ContextSwitchConfirmation {
  isOpen: boolean
  targetContextId: string | null
}

// Add interface for context view dialog
interface ContextViewDialog {
  isOpen: boolean
  context: Context | null
}

// Helper function to extract text from PlateJS Value
const extractTextFromValue = (value: any): string => {
  if (typeof value === 'string') {
    return value
  }
  
  if (Array.isArray(value)) {
    return value
      .map(node => {
        if (node.children && Array.isArray(node.children)) {
          return node.children.map((child: any) => child.text || '').join('')
        }
        return ''
      })
      .join(' ')
  }
  
  return ''
}

export function RightSideBar({ children, className }: RightSideBarProps) {
  const { setActiveContextTitle } = useContextStore()
  
  // State for contexts
  const [contexts, setContexts] = useState<Context[]>(() => {
    const saved = localStorage.getItem('typenext-contexts')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        // Convert any existing PlateJS Value descriptions to strings
        return parsed.map((context: any) => ({
          ...context,
          description: extractTextFromValue(context.description)
        }))
      } catch (e) {
        console.error('Failed to parse contexts from localStorage', e)
        return []
      }
    }
    return []
  })
  
  // State for UI controls
  const [isAddSheetOpen, setIsAddSheetOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  // Add state for context switch confirmation dialog
  const [contextSwitchConfirmation, setContextSwitchConfirmation] = useState<ContextSwitchConfirmation>({
    isOpen: false,
    targetContextId: null
  })
  // Add state for context view dialog
  const [contextViewDialog, setContextViewDialog] = useState<ContextViewDialog>({
    isOpen: false,
    context: null
  })
  const [contextToDelete, setContextToDelete] = useState<Context | null>(null)
  const [newContextTitle, setNewContextTitle] = useState('')
  const [newContextDescription, setNewContextDescription] = useState('')
  const [droppedFiles, setDroppedFiles] = useState<File[]>([])

  // Save contexts to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('typenext-contexts', JSON.stringify(contexts))
    
    // Update window title when active context changes
    const activeContext = contexts.find(context => context.isActive)
    updateWindowTitle(activeContext?.title)
    
    // Update the context store
    setActiveContextTitle(activeContext?.title || null)
  }, [contexts, setActiveContextTitle])

  // Update window title using Tauri API
  const updateWindowTitle = async (contextTitle?: string) => {
    try {
      const appWindow = getCurrentWindow()
      const baseTitle = 'TypeNext AI'
      const newTitle = contextTitle ? `${baseTitle} - ${contextTitle}` : baseTitle
      await appWindow.setTitle(newTitle)
    } catch (error) {
      console.error('Failed to update window title:', error)
      // Fallback to document.title
      const baseTitle = 'TypeNext AI'
      document.title = contextTitle ? `${baseTitle} - ${contextTitle}` : baseTitle
    }
  }

  // Add a new context
  const handleAddContext = () => {
    if (!newContextTitle.trim()) return
    
    const newContext: Context = {
      id: Date.now().toString(),
      title: newContextTitle,
      description: newContextDescription,
      // Use dropped file names instead of attachedFiles
      files: droppedFiles.map(file => file.name),
      isActive: contexts.length === 0, // First context is active by default
    }
    
    setContexts(prev => {
      // Deactivate all other contexts if this is the first one or if we're setting this as active
      const updated = prev.map(context => ({
        ...context,
        isActive: false
      }))
      return [...updated, newContext]
    })
    
    // Reset form
    setNewContextTitle('')
    setNewContextDescription('')
    setDroppedFiles([]) // Reset dropped files instead of attachedFiles
    setIsAddSheetOpen(false)
  }

  // Activate a context with confirmation
  const handleActivateContext = (id: string) => {
    const currentActiveContext = contexts.find(context => context.isActive)
    
    // If clicking on already active context, do nothing
    if (currentActiveContext && currentActiveContext.id === id) {
      return
    }
    
    // If there's no active context, directly activate the clicked context
    if (!currentActiveContext) {
      setContexts(prev => 
        prev.map(context => ({
          ...context,
          isActive: context.id === id
        }))
      )
      return
    }
    
    // Open confirmation dialog when switching from one active context to another
    setContextSwitchConfirmation({
      isOpen: true,
      targetContextId: id
    })
  }

  // Confirm context switch
  const confirmContextSwitch = () => {
    if (!contextSwitchConfirmation.targetContextId) return
    
    setContexts(prev => 
      prev.map(context => ({
        ...context,
        isActive: context.id === contextSwitchConfirmation.targetContextId
      }))
    )
    
    setContextSwitchConfirmation({
      isOpen: false,
      targetContextId: null
    })
  }

  // Cancel context switch
  const cancelContextSwitch = () => {
    setContextSwitchConfirmation({
      isOpen: false,
      targetContextId: null
    })
  }

  // Open delete confirmation dialog
  const handleDeleteContext = (context: Context) => {
    setContextToDelete(context)
    setIsDeleteDialogOpen(true)
  }

  // Confirm deletion
  const confirmDeleteContext = () => {
    if (!contextToDelete) return
    
    setContexts(prev => {
      const updated = prev.filter(context => context.id !== contextToDelete.id)
      
      // If we deleted the active context, activate the first remaining one
      if (contextToDelete.isActive && updated.length > 0) {
        updated[0]!.isActive = true
      }
      
      return updated
    })
    
    setIsDeleteDialogOpen(false)
    setContextToDelete(null)
  }

  // Open context view dialog
  const handleViewContext = (context: Context) => {
    setContextViewDialog({
      isOpen: true,
      context: context
    })
  }

  // Close context view dialog
  const closeContextViewDialog = () => {
    setContextViewDialog({
      isOpen: false,
      context: null
    })
  }

  // Add a function to reset the form data
  const resetForm = () => {
    setNewContextTitle('')
    setNewContextDescription('')
    setDroppedFiles([])
  }
  
  // Modify the setIsAddSheetOpen function to reset form when closing
  const handleSheetOpenChange = (open: boolean) => {
    setIsAddSheetOpen(open)
    // Reset form data when sheet is closed
    if (!open) {
      resetForm()
    }
  }

  return (
    <div
      className={cn('flex h-full flex-col border-l bg-background', className)}
    >
      <div className="p-4 border-b">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Contexts</h2>
          <Button 
            size="sm" 
            onClick={() => setIsAddSheetOpen(true)}
          >
            <PlusIcon className="h-4 w-4 mr-2" />
            Add
          </Button>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2">
        {contexts.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground">
            No contexts yet. Add your first context to get started.
          </div>
        ) : (
          <div className="space-y-2">
            {contexts.map(context => (
              <div 
                key={context.id}
                className={cn(
                  "p-3 rounded-lg border-2 transition-all hover:bg-accent relative",
                  context.isActive 
                    ? "border-primary bg-primary/10" 
                    : "border-transparent hover:border-primary/30"
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleViewContext(context);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // Show dropdown menu with view and activate options
                  // For now, we'll just show an alert with the options
                  const shouldActivate = confirm(`Context: ${context.title}\n\nChoose an option:\n- OK: View context\n- Cancel: Activate context`);
                  if (shouldActivate) {
                    if (!context.isActive) {
                      handleActivateContext(context.id);
                    }
                  } else {
                    handleViewContext(context);
                  }
                }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center">
                      <h3 className="font-medium">{context.title}</h3>
                      {context.isActive && (
                        // Add blinking badge for active context
                        <span className="ml-2 relative flex h-3 w-3">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                      {extractTextFromValue(context.description) || 'No description'}
                    </p>
                    {context.files.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {context.files.map((file, index) => (
                          <span 
                            key={index}
                            className="inline-flex items-center px-2 py-1 text-xs bg-secondary rounded-full"
                          >
                            {file}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteContext(context);
                    }}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      
      {/* Add Context Sheet */}
      <Sheet open={isAddSheetOpen} onOpenChange={handleSheetOpenChange}>
        <SheetContent side="right" className="w-3/4 max-w-md p-0 flex flex-col">
          <SheetHeader className="px-4 py-2">
            <SheetTitle>Add New Context</SheetTitle>
          </SheetHeader>
          
          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-4">
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium">Title</label>
                    <Input
                      value={newContextTitle}
                      onChange={(e) => setNewContextTitle(e.target.value)}
                      placeholder="Enter context title"
                      className="mt-1 w-full"
                    />
                  </div>
                  
                  <div>
                    <label className="text-sm font-medium">Description</label>
                    <Textarea
                      value={newContextDescription}
                      onChange={(e) => setNewContextDescription(e.target.value)}
                      placeholder="Enter context description..."
                      className="mt-1 min-h-[100px] w-full"
                    />
                  </div>
                  
                  <div className="w-full">
                    <label className="text-sm font-medium">Attached Files</label>
                    <div className="mt-1 w-full">
                      <div className="w-full max-w-full">
                        <Dropzone
                          className="w-full max-w-full h-32 flex flex-col items-center justify-center border-2 border-dashed border-muted-foreground/25 rounded-md cursor-pointer"
                          accept={{
                            'text/markdown': ['.md'],
                            'text/plain': ['.txt'],
                            'application/pdf': ['.pdf']
                          }}
                          onDrop={(acceptedFiles) => {
                            // Allow multiple files by combining with existing files
                            setDroppedFiles(prev => [...prev, ...acceptedFiles])
                          }}
                          src={droppedFiles}
                          multiple={true}
                        >
                          {/* Custom DropzoneContent to prevent width expansion */}
                          {droppedFiles.length > 0 ? (
                            <div className="flex flex-col items-center justify-center w-full h-full p-4">
                              <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                <UploadIcon size={16} />
                              </div>
                              <p className="my-2 w-full truncate font-medium text-sm text-center">
                                {droppedFiles.length} file(s) selected
                              </p>
                              <p className="w-full truncate text-wrap text-muted-foreground text-xs text-center">
                                Drag and drop or click to replace
                              </p>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center justify-center w-full h-full p-4">
                              <div className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                <UploadIcon size={16} />
                              </div>
                              <p className="my-2 font-medium text-sm">
                                Upload files
                              </p>
                              <p className="text-wrap text-muted-foreground text-xs">
                                Drag and drop or click to upload
                              </p>
                              <p className="text-wrap text-muted-foreground text-xs">
                                Accepts .md, .txt, .pdf
                              </p>
                            </div>
                          )}
                        </Dropzone>
                      </div>
                    </div>
                    
                    {droppedFiles.length > 0 && (
                      <div className="mt-2 w-full">
                        <ScrollArea className="max-h-32 w-full">
                          <div className="p-2">
                            <div className="space-y-2">
                              {droppedFiles.map((file, index) => (
                                <div 
                                  key={index}
                                  className="flex items-center justify-between p-2 bg-secondary rounded-md"
                                >
                                  <div className="flex items-center min-w-0 flex-1">
                                    <UploadIcon className="h-4 w-4 mr-2 text-muted-foreground flex-shrink-0" />
                                    <span className="text-sm truncate">{file.name}</span>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 flex-shrink-0 ml-2"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDroppedFiles(prev => prev.filter((_, i) => i !== index));
                                    }}
                                  >
                                    <TrashIcon className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        </ScrollArea>
                      </div>
                    )}
                  </div>

                </div>
              </div>
            </ScrollArea>
          </div>
          
          <SheetFooter className="px-4 py-2 border-t">
            <SheetClose asChild>
              <Button variant="outline">Cancel</Button>
            </SheetClose>
            <Button 
              onClick={handleAddContext}
              disabled={!newContextTitle.trim()}
            >
              Add Context
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      
      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Context</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the context "{contextToDelete?.title}"? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              className="bg-destructive hover:bg-destructive/90"
              onClick={confirmDeleteContext}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      
      {/* Context Switch Confirmation Dialog */}
      <AlertDialog open={contextSwitchConfirmation.isOpen} onOpenChange={cancelContextSwitch}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch Context</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to switch to this context? Any unsaved changes in the current context may be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelContextSwitch}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmContextSwitch}>
              Switch Context
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      
      {/* Context View Dialog */}
      <Dialog open={contextViewDialog.isOpen} onOpenChange={closeContextViewDialog}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{contextViewDialog.context?.title}</DialogTitle>
            {contextViewDialog.context?.isActive && (
              <div className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary w-fit">
                <span className="relative flex h-2 w-2 mr-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
                Active
              </div>
            )}
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium">Description</h4>
              <p className="mt-1 text-sm text-muted-foreground">
                {extractTextFromValue(contextViewDialog.context?.description) || 'No description provided'}
              </p>
            </div>
            
            {contextViewDialog.context?.files && contextViewDialog.context.files.length > 0 && (
              <div>
                <h4 className="text-sm font-medium">Attached Files</h4>
                <div className="mt-2 space-y-2">
                  {contextViewDialog.context.files.map((file, index) => (
                    <div key={index} className="flex items-center p-2 bg-secondary rounded-md">
                      <UploadIcon className="h-4 w-4 mr-2 text-muted-foreground" />
                      <span className="text-sm">{file}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={closeContextViewDialog}>Close</Button>
            {!contextViewDialog.context?.isActive && (
              <Button onClick={() => {
                if (contextViewDialog.context) {
                  handleActivateContext(contextViewDialog.context.id)
                  closeContextViewDialog()
                }
              }}>
                Activate
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {children}
    </div>
  )
}

export default RightSideBar