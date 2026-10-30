import type { IconNode } from "lucide-react";
import { type TargetAndTransition, useAnimationControls } from "motion/react";
import { g as MotionGroup, path as MotionPath } from "motion/react-m";
import {
  createElement,
  forwardRef,
  type SVGProps,
  useContext,
  useEffect,
  useRef,
} from "react";
import { IconAnimationContext } from "./icon-motion";

export interface AnimatedIconProps extends SVGProps<SVGSVGElement> {
  size?: string | number;
}
export interface IconRecipe {
  duration?: number;
  motion: TargetAndTransition;
  parts?: number[];
  partVariants?: Record<
    number,
    { normal: TargetAndTransition; animate: TargetAndTransition }
  >;
}

// Motion recipes adapted from pqoqubbw/icons @ 4662fff2b60fdcf4751b32013606756caf7c4c26.
// Most geometry follows lucide-react; selected navigation icons use upstream geometry.
// See licenses/Lucide-Animated-MIT.txt.
export function createAnimatedIcon(
  name: string,
  nodes: IconNode,
  recipe: IconRecipe
) {
  const AnimatedIcon = forwardRef<SVGSVGElement, AnimatedIconProps>(
    (
      { size = 16, className = "", strokeWidth = 2, children, ...props },
      ref
    ) => {
      const { allowed, sequence, engaged } = useContext(IconAnimationContext);
      const controls = useAnimationControls();
      const lastSequence = useRef(sequence);
      useEffect(() => {
        controls.stop();
        if (!allowed || sequence === 0) {
          controls.set("normal");
        } else if (!engaged) {
          controls.start("normal", { duration: 0.12 });
        } else if (sequence !== lastSequence.current) {
          controls.set("normal");
          controls.start("animate");
        }
        lastSequence.current = sequence;
        return () => controls.stop();
      }, [allowed, engaged, sequence, controls]);
      const normal = Object.fromEntries(
        Object.keys(recipe.motion)
          .filter((key) => key !== "transition")
          .map((key) => [
            key,
            key === "scale" || key === "pathLength" || key === "opacity"
              ? 1
              : 0,
          ])
      );
      const variants = {
        normal,
        animate: {
          ...recipe.motion,
          transition: {
            duration: recipe.duration ?? 0.3,
            ease: "easeInOut" as const,
          },
        },
      };
      const parts = nodes.map(([tag, attributes], index) => {
        const { key, ...attributesWithoutKey } = attributes;
        const element = createElement(tag, { ...attributesWithoutKey, key });
        const part = recipe.partVariants?.[index];
        const partVariants = part
          ? {
              normal: part.normal,
              animate: {
                ...part.animate,
                transition: {
                  ...variants.animate.transition,
                  ...part.animate.transition,
                },
              },
            }
          : variants;
        if (
          tag === "path" &&
          part &&
          (part.normal.d !== undefined || part.normal.pathLength !== undefined)
        ) {
          return (
            <MotionPath
              {...attributesWithoutKey}
              animate={controls}
              initial={false}
              key={key}
              variants={partVariants}
            />
          );
        }
        return part || !recipe.parts || recipe.parts.includes(index) ? (
          <MotionGroup
            animate={controls}
            initial={false}
            key={key}
            style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}
            variants={partVariants}
          >
            {element}
          </MotionGroup>
        ) : (
          element
        );
      });
      return (
        <svg
          aria-hidden="true"
          className={`lucide lucide-${name} shrink-0 ${className}`}
          data-animated-icon={name}
          fill="none"
          focusable="false"
          height={size}
          ref={ref}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={strokeWidth}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
          {...props}
        >
          {parts}
          {children}
        </svg>
      );
    }
  );
  AnimatedIcon.displayName = `Animated(${name})`;
  return AnimatedIcon;
}
