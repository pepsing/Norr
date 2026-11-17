import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

export default class EntryAbility extends UIAbility {
  onForeground(): void {
    AppStorage.setOrCreate('norrActive', true);
    AppStorage.setOrCreate('norrWakeGeneration', (AppStorage.get<number>('norrWakeGeneration') || 0) + 1);
  }

  onBackground(): void {
    AppStorage.setOrCreate('norrActive', false);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    try {
      const mainWindow = windowStage.getMainWindowSync();
      AppStorage.setOrCreate('norrMainWindow', mainWindow);
      mainWindow.setWindowLayoutFullScreen(false).catch((error: BusinessError) => {
        hilog.error(0, 'Norr', 'Window layout failed (%{public}d)', error.code);
      });
    } catch (error) {
      hilog.error(0, 'Norr', 'Window initialization failed (%{public}d)', (error as BusinessError).code);
    }
    windowStage.loadContent('pages/Index', (error: BusinessError) => {
      if (error.code) {
        hilog.error(0, 'Norr', 'Page initialization failed (%{public}d)', error.code);
      }
    });
  }

  onWindowStageDestroy(): void {
    AppStorage.delete('norrMainWindow');
  }
}
