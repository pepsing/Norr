#import "NorrWindowRegions.h"

void NorrTrackWindowDivision(UIView *view, void (^hingeAvailabilityChanged)(BOOL)) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
        __weak UIView *target = view;
        [view registerForTraitChanges:UITraitCollection.systemTraitsAffectingVerticalBarEdge withHandler:^(UIView *changedView, UITraitCollection *previous) {
            [changedView setNeedsLayout];
        }];
        [view addInteraction:[[UIHingeInteraction alloc] initWithUpdateHandler:^(UIHingeInteraction *interaction, UIHingeInteractionUpdate *update) {
            hingeAvailabilityChanged(update.hinge != nil);
            [target setNeedsLayout];
        }]];
    }
#endif
}

BOOL NorrHasVerticalBarEdge(UIView *view) {
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
        return view.traitCollection.verticalBarEdge != UIVerticalBarEdgeUnspecified;
    }
#endif
    return NO;
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
