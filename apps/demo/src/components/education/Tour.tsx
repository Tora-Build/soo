/**
 * Tour Component - Guided walkthroughs for new users
 * 
 * Creates a spotlight effect on target elements and shows
 * step-by-step instructions for using the interface.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, SkipForward } from 'lucide-react';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';

export interface TourStep {
  target: string; // CSS selector
  title: string;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  action?: () => void; // Optional action to perform on this step
}

interface TourProps {
  id: string; // For localStorage tracking
  steps: TourStep[];
  onComplete: () => void;
  onSkip: () => void;
  autoStart?: boolean;
}

export const Tour: React.FC<TourProps> = ({
  id,
  steps,
  onComplete,
  onSkip,
  autoStart = false,
}) => {
  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Check if tour was already completed
  useEffect(() => {
    const completed = localStorage.getItem(`tour_${id}_completed`);
    if (!completed && autoStart) {
      setIsActive(true);
    }
  }, [id, autoStart]);

  // Find and highlight target element
  useEffect(() => {
    if (!isActive) return;

    const step = steps[currentStep];
    if (!step) return;

    const target = document.querySelector(step.target);
    if (target) {
      // Get element position
      const rect = target.getBoundingClientRect();
      setTargetRect(rect);

      // Add spotlight class
      target.classList.add('edu-spotlight');

      // Scroll into view if needed
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Execute step action if defined
      if (step.action) {
        step.action();
      }

      return () => {
        target.classList.remove('edu-spotlight');
      };
    }
  }, [isActive, currentStep, steps]);

  // Position tooltip based on target
  const getTooltipPosition = useCallback((): React.CSSProperties => {
    if (!targetRect || !tooltipRef.current) return {};

    const step = steps[currentStep];
    const position = step?.position || 'bottom';
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const padding = 16;

    let top = 0;
    let left = 0;

    switch (position) {
      case 'top':
        top = targetRect.top - tooltipRect.height - padding;
        left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
        break;
      case 'bottom':
        top = targetRect.bottom + padding;
        left = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
        break;
      case 'left':
        top = targetRect.top + (targetRect.height - tooltipRect.height) / 2;
        left = targetRect.left - tooltipRect.width - padding;
        break;
      case 'right':
        top = targetRect.top + (targetRect.height - tooltipRect.height) / 2;
        left = targetRect.right + padding;
        break;
    }

    // Keep tooltip in viewport
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (left < padding) left = padding;
    if (left + tooltipRect.width > viewportWidth - padding) {
      left = viewportWidth - tooltipRect.width - padding;
    }
    if (top < padding) top = padding;
    if (top + tooltipRect.height > viewportHeight - padding) {
      top = viewportHeight - tooltipRect.height - padding;
    }

    return { top, left };
  }, [targetRect, currentStep, steps]);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1);
    }
  };

  const handleComplete = () => {
    localStorage.setItem(`tour_${id}_completed`, 'true');
    setIsActive(false);
    onComplete();
  };

  const handleSkip = () => {
    localStorage.setItem(`tour_${id}_completed`, 'true');
    setIsActive(false);
    onSkip();
  };

  const startTour = () => {
    setCurrentStep(0);
    setIsActive(true);
  };

  const step = steps[currentStep];

  if (!isActive) {
    return null;
  }

  return (
    <>
      {/* Backdrop with spotlight cutout */}
      <div className="edu-backdrop" onClick={handleSkip}>
        {targetRect && (
          <div
            className="absolute bg-transparent"
            style={{
              top: targetRect.top - 4,
              left: targetRect.left - 4,
              width: targetRect.width + 8,
              height: targetRect.height + 8,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.7)',
            }}
          />
        )}
      </div>

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className="fixed z-tour w-80"
        style={getTooltipPosition()}
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-tooltip border border-rule p-4 text-ink shadow-none">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-bold text-ink">{step?.title}</h4>
            <button
              onClick={handleSkip}
              className="text-ink hover:text-muted transition-colors"
              aria-label="Close tour"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <p className="text-sm text-ink leading-relaxed mb-4">
            {step?.content}
          </p>

          {/* Progress dots */}
          <div className="flex items-center justify-center gap-1.5 mb-4">
            {steps.map((_, i) => (
              <div
                key={i}
                className={cn(
                  'w-1.5 h-1.5 rounded-full transition-all',
                  i === currentStep
                    ? 'w-4 bg-accent'
                    : i < currentStep
                    ? 'bg-accent-muted'
                    : 'bg-raised'
                )}
              />
            ))}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between">
            <button
              onClick={handleSkip}
              className="text-xs text-ink hover:text-muted flex items-center gap-1"
            >
              <SkipForward className="w-3 h-3" />
              Skip tour
            </button>

            <div className="flex gap-2">
              {currentStep > 0 && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={handlePrev}
                >
                  <ChevronLeft className="w-3 h-3" />
                </Button>
              )}
              <Button
                variant="primary"
                size="xs"
                onClick={handleNext}
              >
                {currentStep === steps.length - 1 ? 'Finish' : 'Next'}
                {currentStep < steps.length - 1 && <ChevronRight className="w-3 h-3 ml-1" />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

// Pre-defined tour configurations
export const TRADE_PAGE_TOUR: TourStep[] = [
  {
    target: '[data-tour="market-selector"]',
    title: 'Choose a Market',
    content: 'Browse and search for prediction markets. Click on any market to start trading.',
    position: 'right',
  },
  {
    target: '[data-tour="probability-display"]',
    title: 'Market Probability',
    content: 'This shows the current price. 52% YES means the crowd thinks there\'s a 52% chance this happens.',
    position: 'bottom',
  },
  {
    target: '[data-tour="trading-panel"]',
    title: 'Place Your Trade',
    content: 'Select YES or NO, enter an amount, and click to trade. The quote updates in real-time.',
    position: 'left',
  },
  {
    target: '[data-tour="positions"]',
    title: 'Your Positions',
    content: 'After trading, your shares appear here. Sell anytime (24h lock applies to proceeds).',
    position: 'left',
  },
];

export const CREATE_PAGE_TOUR: TourStep[] = [
  {
    target: '[data-tour="role-indicator"]',
    title: 'Your Roles',
    content: 'See which markets you\'ve created and which you can adjudicate.',
    position: 'bottom',
  },
  {
    target: '[data-tour="markets-tab"]',
    title: 'Your Markets',
    content: 'Track LP position, fees earned, and graduation progress for markets you created.',
    position: 'bottom',
  },
  {
    target: '[data-tour="settlements-tab"]',
    title: 'Pending Settlements',
    content: 'If you\'re an adjudicator, markets awaiting your settlement decision appear here.',
    position: 'bottom',
  },
  {
    target: '[data-tour="create-tab"]',
    title: 'Create New Market',
    content: 'Follow the wizard to create a new prediction market. Choose your question, liquidity, and roles.',
    position: 'bottom',
  },
];

// Hook to manage tour state
export const useTour = (tourId: string) => {
  const [hasSeenTour, setHasSeenTour] = useState(() => {
    return localStorage.getItem(`tour_${tourId}_completed`) === 'true';
  });

  const resetTour = () => {
    localStorage.removeItem(`tour_${tourId}_completed`);
    setHasSeenTour(false);
  };

  const markComplete = () => {
    localStorage.setItem(`tour_${tourId}_completed`, 'true');
    setHasSeenTour(true);
  };

  return { hasSeenTour, resetTour, markComplete };
};

export default Tour;
