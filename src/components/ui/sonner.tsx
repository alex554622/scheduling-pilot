import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      // Sonner's own offsets (24px, 16px on phones) plus the safe-area insets,
      // which are 0px on the website and the status-bar/home-indicator height
      // in the Android and iOS apps (see styles.css).
      offset={{
        top: "calc(24px + var(--sat))",
        bottom: "calc(24px + var(--sab))",
        left: "calc(24px + var(--sal))",
        right: "calc(24px + var(--sar))",
      }}
      mobileOffset={{
        top: "calc(16px + var(--sat))",
        bottom: "calc(16px + var(--sab))",
        left: "calc(16px + var(--sal))",
        right: "calc(16px + var(--sar))",
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
