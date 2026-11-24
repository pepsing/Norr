#import "NorrWindowRegions.h"

void NorrTrackWindowDivision(UIView *view) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
        __weak UIView *target = view;
        [view addInteraction:[[UIHingeInteraction alloc] initWithUpdateHandler:^(UIHingeInteraction *interaction, UIHingeInteractionUpdate *update) {
            [target setNeedsLayout];
        }]];
    }
#endif
}

CGRect NorrWindowDivision(UIView *view) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
        for (UIViewReservedRegion *region in [view reservedRegionsOfKind:UIViewReservedRegionKind.divisionRegionKind]) {
            if (region.isActive && CGRectIntersectsRect(view.bounds, region.frame)) return region.frame;
        }
    }
#endif
    return CGRectNull;
}
