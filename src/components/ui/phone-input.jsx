import React, { useState } from 'react';
import { Input } from '@/components/ui/input';

const formatPhoneNumber = (phoneString) => {
  if (!phoneString) return '';
  const cleaned = ('' + phoneString).replace(/\D/g, '');
  
  // Handle different lengths
  if (cleaned.length === 0) return '';
  if (cleaned.length <= 3) return cleaned;
  if (cleaned.length <= 6) return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3)}`;
  if (cleaned.length <= 10) return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  
  // Handle 11 digits (with country code)
  if (cleaned.length === 11 && cleaned[0] === '1') {
    return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7, 11)}`;
  }
  
  // Truncate to 10 digits if longer
  return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 10)}`;
};

const unformatPhoneNumber = (phoneString) => {
  return ('' + phoneString).replace(/\D/g, '');
};

export const PhoneInput = React.forwardRef(({ value, onChange, ...props }, ref) => {
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = (e) => {
    setIsFocused(true);
    // Select all text when focused for easy editing
    setTimeout(() => {
      e.target.select();
    }, 0);
    if (props.onFocus) props.onFocus(e);
  };

  const handleBlur = (e) => {
    setIsFocused(false);
    if (props.onBlur) props.onBlur(e);
  };
  
  const handleChange = (e) => {
    // Always store unformatted value
    const unformattedValue = unformatPhoneNumber(e.target.value);
    onChange(unformattedValue);
  };

  // Show unformatted when focused, formatted when not
  const displayValue = isFocused ? value : formatPhoneNumber(value);

  return (
    <Input
      ref={ref}
      {...props}
      type="tel"
      value={displayValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  );
});

PhoneInput.displayName = "PhoneInput";

// Export format function for use in display-only contexts
export { formatPhoneNumber };