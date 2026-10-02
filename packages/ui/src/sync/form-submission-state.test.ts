import { beforeEach, describe, expect, test } from "bun:test"
import { initialFormValues } from "@/components/chat/formCardState"
import { formSubmissionKey, useFormSubmissionStore } from "./form-submission-state"

const identity = { runtimeKey: "runtime-a", sessionID: "session-a", requestID: "form-a" }
const draft = () => ({ fieldsSignature: "answer:string", values: initialFormValues([{ key: "answer", type: "string", title: "Answer" }]), step: 1 })
const read = (owner = identity) => useFormSubmissionStore.getState().submissions.get(formSubmissionKey(owner))

describe("form submission ownership", () => {
  beforeEach(() => useFormSubmissionStore.setState({ submissions: new Map() }))

  test("retains exact field drafts and step across pending, remount, and failure", () => {
    const submitted = draft()
    submitted.values.answer.text = "  exact custom answer  "
    const store = useFormSubmissionStore.getState()
    expect(store.begin(identity, submitted)).toBe(true)
    expect(store.begin(identity, draft())).toBe(false)
    store.save(identity, draft())
    expect(read()).toEqual({ ...submitted, pending: true })
    store.release(identity)
    expect(read()).toEqual({ ...submitted, pending: false })
    const edited = draft()
    edited.values.answer.text = "retry edit"
    store.save(identity, edited)
    expect(read()).toEqual({ ...edited, pending: false })
    expect(store.begin(identity, edited)).toBe(true)
  })

  test("clears only the exact runtime, session, and form owner", () => {
    const otherRuntime = { ...identity, runtimeKey: "runtime-b" }
    const otherSession = { ...identity, sessionID: "session-b" }
    const store = useFormSubmissionStore.getState()
    for (const owner of [identity, otherRuntime, otherSession]) store.begin(owner, draft())
    store.clear(identity)
    store.release(identity)
    expect(read()).toBeUndefined()
    expect(read(otherRuntime)?.pending).toBe(true)
    expect(read(otherSession)?.pending).toBe(true)
  })

  test("draft retention never evicts an in-flight submission", () => {
    const store = useFormSubmissionStore.getState()
    store.begin(identity, draft())
    for (let index = 0; index < 100; index++) store.save({ ...identity, requestID: `form-${index}` }, draft())
    expect(read()?.pending).toBe(true)
    expect(useFormSubmissionStore.getState().submissions.size).toBe(50)
  })
})
