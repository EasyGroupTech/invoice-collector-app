import type { FieldDescriptor } from 'invoice-collector-plugin-sdk';

interface FieldInputProps {
  field: FieldDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
}

/** Renders one FieldDescriptor (§8) bound to a value/onChange pair — the caller owns the actual
 * field-value state (ordinary React state), this is purely presentational + type-dispatch. */
export function FieldInput({ field, value, onChange }: FieldInputProps) {
  const id = `field-${field.name}`;

  if (field.type === 'checkbox') {
    return (
      <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
        {field.required ? ' *' : ''}
      </label>
    );
  }

  if (field.type === 'select') {
    return (
      <label htmlFor={id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {field.label}
        {field.required ? ' *' : ''}
        <select id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            Select…
          </option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.type === 'textarea') {
    return (
      <label htmlFor={id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {field.label}
        {field.required ? ' *' : ''}
        <textarea
          id={id}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  const inputType = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';

  return (
    <label htmlFor={id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {field.label}
      {field.required ? ' *' : ''}
      <input
        id={id}
        type={inputType}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        placeholder={field.placeholder}
        onChange={(e) => onChange(field.type === 'number' ? e.target.valueAsNumber : e.target.value)}
      />
    </label>
  );
}
