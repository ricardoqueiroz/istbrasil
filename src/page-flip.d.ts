declare module 'page-flip' {
    export interface PageFlipOptions {
        width: number;
        height: number;
        size?: 'fixed' | 'stretch';
        minWidth?: number;
        maxWidth?: number;
        minHeight?: number;
        maxHeight?: number;
        drawShadow?: boolean;
        flippingTime?: number;
        usePortrait?: boolean;
        startPage?: number;
        startZIndex?: number;
        autoSize?: boolean;
        maxShadowOpacity?: number;
        showCover?: boolean;
        mobileScrollSupport?: boolean;
        clickEventForward?: boolean;
        useMouseEvents?: boolean;
    }

    export class PageFlip {
        constructor(element: HTMLElement, options: PageFlipOptions);
        loadFromHTML(elements: NodeListOf<HTMLElement> | HTMLElement[]): void;
        on(event: string, callback: (event: any) => void): void;
        off(event: string, callback: (event: any) => void): void;
        destroy(): void;
        flipNext(corner?: 'top' | 'bottom'): void;
        flipPrev(corner?: 'top' | 'bottom'): void;
        flip(pageIndex: number, corner?: 'top' | 'bottom'): void;
        turnToPage(pageIndex: number): void;
        turnToNext(): void;
        turnToPrev(): void;
        getPageCount(): number;
        getCurrentPageIndex(): number;
        getOrientation(): 'portrait' | 'landscape';
        update(options: Partial<PageFlipOptions>): void;
    }
}