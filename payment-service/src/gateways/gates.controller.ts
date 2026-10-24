import { Controller, ForbiddenException, Get, Query, Req } from '@nestjs/common';
import { GatesManagerService } from './gates-manager.services';
import * as moment from 'moment-timezone';
import { OnEvent } from '@nestjs/event-emitter';
import { GATEWAY_START_CRON, GATEWAY_STOP_CRON } from 'src/shards/events';

@Controller('gateways')
export class GatesController {
  constructor(private readonly gateManagerService: GatesManagerService) {}

  @Get('stop-gate')
  stopGate(
    @Query('name') name: string,
    @Query('time_in_sec') timeInSec: number,
    @Req() req: any,
  ) {
    const token = process.env.PAYMENT_SERVICE_ADMIN_TOKEN;
    const providedToken =
      req.headers['x-admin-token'] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token || providedToken !== token) {
      throw new ForbiddenException('Forbidden');
    }

    this.gateManagerService.stopCron(name, timeInSec);
    return {
      message: 'ok',
      next_run: moment()
        .add(timeInSec, 'seconds')
        .tz('Asia/Ho_Chi_Minh')
        .format('DD-MM-YYYY HH:mm:ss'),
    };
  }

  @OnEvent(GATEWAY_STOP_CRON)
  stopGateCron(payload?: { minutes: number }) {
    const minutes = payload?.minutes || 5;
    this.gateManagerService.stopAllCron(minutes);
  }

  @OnEvent(GATEWAY_START_CRON)
  startGateCron() {
    this.gateManagerService.startAllCron();
  }
}
