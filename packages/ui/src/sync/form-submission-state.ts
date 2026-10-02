import { create } from "zustand"

export type FormSubmissionIdentity = { runtimeKey: string; sessionID: string; requestID: string }

export type FormFieldDraft = {
  text: string
  number: number | null
  boolean: boolean
  selected: string[]
  custom: boolean
  acknowledged: boolean
}

export type FormDraft = {
  fieldsSignature: string
  values: Record<string, FormFieldDraft>
  step: number
}

type FormSubmission = FormDraft & { pending: boolean }

export const formSubmissionKey = ({ runtimeKey, sessionID, requestID }: FormSubmissionIdentity): string =>
  `${runtimeKey}\u0000${sessionID}\u0000${requestID}`

type FormSubmissionState = {
  submissions: Map<string, FormSubmission>
  save: (identity: FormSubmissionIdentity, draft: FormDraft) => void
  begin: (identity: FormSubmissionIdentity, draft: FormDraft) => boolean
  release: (identity: FormSubmissionIdentity) => void
  clear: (identity: FormSubmissionIdentity) => void
}

export const useFormSubmissionStore = create<FormSubmissionState>((set, get) => ({
  submissions: new Map(),
  save: (identity, draft) => {
    const key = formSubmissionKey(identity)
    if (get().submissions.get(key)?.pending) return
    const submissions = new Map(get().submissions)
    submissions.delete(key)
    submissions.set(key, { ...draft, pending: false })
    // Keep pending requests regardless of how many other forms are opened.
    if (submissions.size > 50) {
      for (const [oldKey, entry] of submissions) {
        if (!entry.pending && oldKey !== key) { submissions.delete(oldKey); break }
      }
    }
    set({ submissions })
  },
  begin: (identity, draft) => {
    const key = formSubmissionKey(identity)
    if (get().submissions.get(key)?.pending) return false
    set({ submissions: new Map(get().submissions).set(key, { ...draft, pending: true }) })
    return true
  },
  release: (identity) => {
    const key = formSubmissionKey(identity)
    const current = get().submissions.get(key)
    if (!current?.pending) return
    set({ submissions: new Map(get().submissions).set(key, { ...current, pending: false }) })
  },
  clear: (identity) => {
    const key = formSubmissionKey(identity)
    if (!get().submissions.has(key)) return
    const submissions = new Map(get().submissions)
    submissions.delete(key)
    set({ submissions })
  },
}))
