import { useState } from 'react'
import { Button, Field, Panel, Textarea } from '../components'
import { adminMessage } from '../lib/admin'
import { formatPlainDate } from '../lib/time'
import {
  missionCount,
  validateEntry,
  yearsOfService,
  type EntryFields,
  type ServiceEntry,
} from '../lib/service'
import { supabase } from '../lib/supabase'

const emptyFields: EntryFields = { event_date: '', title: '', location: '', role: '', notes: '' }

type Props = {
  profileId: string
  doe: string | null
  entries: ServiceEntry[]
  canEdit: boolean
  onChange: () => void
}

/**
 * Service record (MVA-210): DOE, years of service and mission count are a display metric only --
 * no computed rank, no tie-break logic. Admin/Command (edit_roster) add, edit and delete entries
 * and set DOE for any member; everyone else sees their own record read-only (the database decides
 * what is visible at all).
 */
export function ServiceRecordPanel({ profileId, doe, entries, canEdit, onChange }: Props) {
  const [doeInput, setDoeInput] = useState(doe ?? '')
  const [doeError, setDoeError] = useState<string | null>(null)
  const [fields, setFields] = useState<EntryFields>(emptyFields)
  const [addError, setAddError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editFields, setEditFields] = useState<EntryFields>(emptyFields)
  const [editError, setEditError] = useState<string | null>(null)

  const years = yearsOfService(doe)
  const sorted = [...entries].sort((a, b) => b.event_date.localeCompare(a.event_date))

  async function saveDoe() {
    if (!supabase) return
    setDoeError(null)
    const { error } = await supabase.rpc('set_doe', { p_profile: profileId, p_doe: doeInput || null })
    if (error) {
      setDoeError(adminMessage(error))
      return
    }
    onChange()
  }

  async function addEntry() {
    if (!supabase) return
    const errors = validateEntry(fields)
    if (Object.keys(errors).length > 0) {
      setAddError('Fix the highlighted fields.')
      return
    }
    setAddError(null)
    const { error } = await supabase.rpc('add_service_entry', {
      p_profile: profileId,
      p_event_date: fields.event_date,
      p_title: fields.title.trim(),
      p_location: fields.location.trim() || null,
      p_role: fields.role.trim() || null,
      p_notes: fields.notes.trim() || null,
    })
    if (error) {
      setAddError(adminMessage(error))
      return
    }
    setFields(emptyFields)
    onChange()
  }

  function startEdit(entry: ServiceEntry) {
    setEditingId(entry.id)
    setEditError(null)
    setEditFields({
      event_date: entry.event_date,
      title: entry.title,
      location: entry.location ?? '',
      role: entry.role ?? '',
      notes: entry.notes ?? '',
    })
  }

  async function saveEdit() {
    if (!supabase || !editingId) return
    const errors = validateEntry(editFields)
    if (Object.keys(errors).length > 0) {
      setEditError('Fix the highlighted fields.')
      return
    }
    setEditError(null)
    const { error } = await supabase.rpc('update_service_entry', {
      p_id: editingId,
      p_event_date: editFields.event_date,
      p_title: editFields.title.trim(),
      p_location: editFields.location.trim() || null,
      p_role: editFields.role.trim() || null,
      p_notes: editFields.notes.trim() || null,
    })
    if (error) {
      setEditError(adminMessage(error))
      return
    }
    setEditingId(null)
    onChange()
  }

  async function deleteEntry(id: string) {
    if (!supabase) return
    const { error } = await supabase.rpc('delete_service_entry', { p_id: id })
    if (!error) onChange()
  }

  return (
    <Panel title="Service record">
      <div className="odz-stack">
        <p>
          {doe ? `DOE ${formatPlainDate(doe)}` : <span className="odz-muted">DOE missing.</span>}
          {years !== null && ` · ${years} year${years === 1 ? '' : 's'} of service`}
          {` · ${missionCount(entries)} mission${missionCount(entries) === 1 ? '' : 's'}`}
        </p>
        {canEdit && (
          <div className="odz-row">
            <Field label="DOE" type="date" value={doeInput} onChange={(e) => setDoeInput(e.target.value)} />
            <Button small onClick={saveDoe}>
              Save DOE
            </Button>
          </div>
        )}
        {doeError && (
          <p role="alert" style={{ color: 'var(--alert)' }}>
            {doeError}
          </p>
        )}

        {sorted.length === 0 ? (
          <p className="odz-muted">No history entries yet.</p>
        ) : (
          <ul className="odz-stack" style={{ listStyle: 'none', padding: 0 }}>
            {sorted.map((entry) =>
              editingId === entry.id ? (
                <li key={entry.id} className="odz-stack">
                  <Field label="Date" type="date" value={editFields.event_date} onChange={(e) => setEditFields({ ...editFields, event_date: e.target.value })} />
                  <Field label="Mission or event name" value={editFields.title} onChange={(e) => setEditFields({ ...editFields, title: e.target.value })} />
                  <Field label="Location (optional)" value={editFields.location} onChange={(e) => setEditFields({ ...editFields, location: e.target.value })} />
                  <Field label="Role (optional)" value={editFields.role} onChange={(e) => setEditFields({ ...editFields, role: e.target.value })} />
                  <Textarea label="Notes (optional)" value={editFields.notes} onChange={(e) => setEditFields({ ...editFields, notes: e.target.value })} />
                  {editError && (
                    <p role="alert" style={{ color: 'var(--alert)' }}>
                      {editError}
                    </p>
                  )}
                  <div className="odz-row">
                    <Button small onClick={saveEdit}>
                      Save
                    </Button>
                    <Button small variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </li>
              ) : (
                <li key={entry.id} className="odz-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <strong>{formatPlainDate(entry.event_date)}</strong> — {entry.title}
                    {entry.location && ` · ${entry.location}`}
                    {entry.role && ` · ${entry.role}`}
                    {entry.notes && <p className="odz-muted">{entry.notes}</p>}
                  </div>
                  {canEdit && (
                    <div className="odz-row">
                      <Button small variant="sec" onClick={() => startEdit(entry)}>
                        Edit
                      </Button>
                      <Button small variant="sec" onClick={() => deleteEntry(entry.id)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        )}

        {canEdit && editingId === null && (
          <div className="odz-stack" style={{ marginTop: '0.5rem' }}>
            <p className="odz-label">Add an entry</p>
            <Field label="Date" type="date" value={fields.event_date} onChange={(e) => setFields({ ...fields, event_date: e.target.value })} />
            <Field label="Mission or event name" value={fields.title} onChange={(e) => setFields({ ...fields, title: e.target.value })} />
            <Field label="Location (optional)" value={fields.location} onChange={(e) => setFields({ ...fields, location: e.target.value })} />
            <Field label="Role (optional)" value={fields.role} onChange={(e) => setFields({ ...fields, role: e.target.value })} />
            <Textarea label="Notes (optional)" value={fields.notes} onChange={(e) => setFields({ ...fields, notes: e.target.value })} />
            {addError && (
              <p role="alert" style={{ color: 'var(--alert)' }}>
                {addError}
              </p>
            )}
            <div>
              <Button small onClick={addEntry}>
                Add entry
              </Button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  )
}
