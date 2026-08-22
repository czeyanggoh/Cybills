import ComboSelect from '@/components/ComboSelect';

// A searchable single-select with a "— None —" reset, used in the supplier and
// customer rule tables. It stays a named wrapper because those tables pass
// `compact`; the behaviour lives in ComboSelect — including the portalled menu,
// without which the last row's dropdown is clipped by the table's own scroll
// box. `options` is an array of strings.
export default function SearchSelect({ value, options, placeholder = '— None —', onChange, compact = false }) {
  return (
    <ComboSelect
      size={compact ? 'xs' : 'lg'}
      value={value}
      // '' is the reset row, and what the field shows when nothing is set.
      options={['', ...options]}
      onChange={onChange}
      emptyLabel={placeholder}
    />
  );
}
