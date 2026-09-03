import type { FieldDescriptor } from 'invoice-collector-plugin-sdk';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

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
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked === true)} />
        <Label htmlFor={id}>
          {field.label}
          {field.required ? ' *' : ''}
        </Label>
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>
          {field.label}
          {field.required ? ' *' : ''}
        </Label>
        <Select value={typeof value === 'string' ? value : undefined} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>
          {field.label}
          {field.required ? ' *' : ''}
        </Label>
        <Textarea
          id={id}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  const inputType = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? ' *' : ''}
      </Label>
      <Input
        id={id}
        type={inputType}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        placeholder={field.placeholder}
        onChange={(e) => onChange(field.type === 'number' ? e.target.valueAsNumber : e.target.value)}
      />
    </div>
  );
}
