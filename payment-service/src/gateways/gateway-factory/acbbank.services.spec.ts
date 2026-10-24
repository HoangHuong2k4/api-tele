import { TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GateType, GateConfig } from '../gate.interface';
import * as moment from 'moment-timezone';
import { ACBBankService } from './acbbank.services';
import { CaptchaSolverService } from 'src/captcha-solver/captcha-solver.service';
import { ProxyService } from 'src/proxy/proxy.service';

// TODO: write tests here
describe('ACBBankService', () => {
  let service: ACBBankService;
  let module: TestingModule;

  const mockConfig: GateConfig = {
    type: GateType.ACBBANK,
    password: 'test-password',
    login_id: 'test-login-id',
    account: 'test-account',
    repeat_interval_in_sec: 30,
    name: 'test',
    token: 'test-token',
    get_transaction_day_limit: 7,
    get_transaction_count_limit: 100,
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  const mockCaptchaSolver = {
    solveCaptcha: jest.fn(),
  };

  const mockProxyService = {
    getProxy: jest.fn(),
  };

  beforeEach(async () => {
    service = new ACBBankService(
      mockConfig,
      mockEventEmitter as unknown as EventEmitter2,
      mockCaptchaSolver as unknown as CaptchaSolverService,
      mockProxyService as unknown as ProxyService,
    );

    service['cron'] = jest.fn();
  });

  afterEach(async () => {});

  describe('parseAcbHistory', () => {
    it('should correctly parse specific transaction with content "DO HUYNH DUC CHUYEN TIEN"', () => {
      const html = `<div class="content-holder">
			    	<h1>Xin chào, DUONG THI MY HUYEN</h1>
			    	<!-- InstanceBeginEditable name="main" -->
                    
		<!-- InstanceBeginEditable name="main" -->

		<script>
		
function smit(form){
	    form.submit();
}

function dosubmit(actionName){
	document.main.dse_nextEventName.value=actionName;
	document.main.submit();
}
function XacNhanSoDu()
{
	// document.main.AccountNbrNo.value=document.main.AccountNbr.options[document.main.AccountNbr.selectedIndex].value;
	dosubmit('xacNhanSoDu');
}

function SubmitByMonth()
{
	document.submitByMonth.AccountNbr.value=document.main.AccountNbr.options[document.main.AccountNbr.selectedIndex].value;
	document.submitByMonth.virtualAccount.value=document.main.virtualAccount.options[document.main.virtualAccount.selectedIndex].value;
 	document.submitByMonth.CheckRef.value=document.main1.CheckRef.checked;
  	document.submitByMonth.EdtRef.value=document.main1.EdtRef.value;
  	document.submitByMonth.dse_nextEventName.value='byMonth';
 	document.submitByMonth.submit();
}

function SubmitByDate()
{
	document.submitByDate.AccountNbr.value=document.main.AccountNbr.options[document.main.AccountNbr.selectedIndex].value;
	document.submitByDate.virtualAccount.value=document.main.virtualAccount.options[document.main.virtualAccount.selectedIndex].value;
	document.submitByDate.CheckRef.value=document.main1.CheckRef.checked;
  	document.submitByDate.EdtRef.value=document.main1.EdtRef.value;
  	document.submitByDate.dse_nextEventName.value='byDate';
  	document.submitByDate.submit();
}

function OutExByDate()
{
	document.submitByDate.AccountNbr.value=document.main.AccountNbr.options[document.main.AccountNbr.selectedIndex].value;
	document.submitByDate.virtualAccount.value=document.main.virtualAccount.options[document.main.virtualAccount.selectedIndex].value;
	document.submitByDate.CheckRef.value=document.main1.CheckRef.checked;
  	document.submitByDate.EdtRef.value=document.main1.EdtRef.value;
  	document.submitByDate.dse_nextEventName.value='outexbydate';
  	document.submitByDate.submit();
}

function OutExByMonth()
{
	document.submitByMonth.AccountNbr.value=document.main.AccountNbr.options[document.main.AccountNbr.selectedIndex].value;
	document.submitByMonth.virtualAccount.value=document.main.virtualAccount.options[document.main.virtualAccount.selectedIndex].value;
	document.submitByMonth.CheckRef.value=document.main1.CheckRef.checked;
  	document.submitByMonth.EdtRef.value=document.main1.EdtRef.value;
  	document.submitByMonth.dse_nextEventName.value='outexbymonth';
  	document.submitByMonth.submit();
}

function OutPrintByDate()
{
	document.submitByDate.AccountNbr.value=document.main.AccountNbr.options[document.main.AccountNbr.selectedIndex].value;
	document.submitByDate.virtualAccount.value=document.main.virtualAccount.options[document.main.virtualAccount.selectedIndex].value;
	document.submitByDate.CheckRef.value=document.main1.CheckRef.checked;
  	document.submitByDate.EdtRef.value=document.main1.EdtRef.value;
  	document.submitByDate.dse_nextEventName.value='outprtbydate';
	document.submitByDate.submit();
}

function OutPrintByMonth()
{
	document.submitByMonth.AccountNbr.value=document.main.AccountNbr.options[document.main.AccountNbr.selectedIndex].value;
	document.submitByMonth.virtualAccount.value=document.main.virtualAccount.options[document.main.virtualAccount.selectedIndex].value;
	document.submitByMonth.CheckRef.value=document.main1.CheckRef.checked;
  	document.submitByMonth.EdtRef.value=document.main1.EdtRef.value;
  	document.submitByMonth.dse_nextEventName.value='outprtbymonth';
	document.submitByMonth.submit();
}
function changeVA(){
	var e = document.getElementById("virtualAccount");
	var strVA = e.options[e.selectedIndex].value;
	if (strVA !== '') {
		document.getElementById("radiobyactivitydate").checked = true;
		document.getElementById("radiobyeffectivedate").disabled = true;
	} else {
		document.getElementById("radiobyeffectivedate").checked = true;
		document.getElementById("radiobyeffectivedate").disabled = false;
	}
}
</script>
		
		<h4>CHI TIẾT THÔNG TIN TÀI KHOẢN</h4>
		<input type="hidden" name="dse_operationName" value="ibkacctSumProc">
        <div class="ruler"></div>
		<table class="table-form">
			<tbody><tr>
				<td class="white_tieude_2">TÀI KHOẢN</td>
			</tr>

			<form name="main" method="post" action="Request"></form>
<input type="hidden" name="dse_sessionId" value="MmEpN2tR_gdSwvvVmqzlCvj">
<input type="hidden" name="dse_applicationId" value="-1">
<input type="hidden" name="dse_operationName" value="ibkacctDetailProc">
<input type="hidden" name="dse_pageId" value="5">
<input type="hidden" name="dse_processorState" value="acctDetailPage">
<input type="hidden" name="dse_processorId" value="JRCSIKCUHXGAFLHCJPANIEBYGIBZGYIGCWDIFEAR">
<input type="hidden" name="dse_errorPage" value="/ibk/acctinquiry/trans.jsp">


				<input type="hidden" name="dse_nextEventName" value="rateDetail" id="rateDetail">
				<tr>
					<td>
					<table>
						<tbody><tr>
							<td class="caption">Chọn tài khoản</td>
							<td><select name="AccountNbr" id="AccountNbr">
<option value="2091577">2091577</option>
<option value="9663467" selected="selected">9663467</option>
</select>
							</td>
						</tr>
						
						<tr class="hiddenTd">
							<td class="caption"></td>
							<td><select name="virtualAccount" id="virtualAccount">
<option value="" selected="selected"></option>
</select>
							</td>
						</tr>
						

						
						<tr>
						<input type="hidden" name="MinorTKXacNhanSoDu" id="MinorTKXacNhanSoDu" value="">
						<input type="hidden" name="MajorTKXacNhanSoDu" id="MajorTKXacNhanSoDu" value="">
						<input type="hidden" name="SoDuTKXacNhanSoDu" id="SoDuTKXacNhanSoDu" value="">
						</tr>
						<tr>
							<td></td>
							<td><a class="img_login" href="#" onclick="smit(main);"> Xem lịch sử lãi suất</a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;					&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
								
								<a class="img_login" href="#" onclick="XacNhanSoDu();"> Xác nhận số dư</a>
								
							</td>

						</tr>
					</tbody></table>
					</td>
				</tr>
				

			

			<tr>
				<td align="center">&nbsp;</td>
			</tr>
			<tr>
				<td class="white_tieude">XEM CHI TIẾT THÔNG TIN TÀI KHOẢN THEO THỜI GIAN GIAO DỊCH </td>
			</tr>
			<tr>
				<td>
				<table>
					<tbody><tr>
						<form name="submitByDate" method="post" action="Request"></form>
<input type="hidden" name="dse_sessionId" value="MmEpN2tR_gdSwvvVmqzlCvj">
<input type="hidden" name="dse_applicationId" value="-1">
<input type="hidden" name="dse_operationName" value="ibkacctDetailProc">
<input type="hidden" name="dse_pageId" value="5">
<input type="hidden" name="dse_processorState" value="acctDetailPage">
<input type="hidden" name="dse_processorId" value="JRCSIKCUHXGAFLHCJPANIEBYGIBZGYIGCWDIFEAR">
<input type="hidden" name="dse_errorPage" value="/ibk/acctinquiry/trans.jsp">


							<td>
							<table class="table-small">
							<tbody>
								<tr>
									<td colspan="2">
										<input type="hidden" name="AccountNbr" id="AccountNbr" value="">
										<input type="hidden" name="virtualAccount" id="virtualAccount" value="">
										<input type="hidden" name="storeName" id="storeName" value="">
										<input type="hidden" name="CheckRef" id="CheckRef" value="">
										<input type="hidden" name="EdtRef" id="EdtRef" value="">
										<input type="hidden" name="dse_nextEventName" value="byDate" id="chooseByDate">
										Theo ngày
										&nbsp;&nbsp;&nbsp;&nbsp;<input type="radio" name="activeDatetimeYN" value="N" checked="checked" id="radiobyeffectivedate"> Ngày hiệu lực
										&nbsp;&nbsp;&nbsp;&nbsp;<input type="radio" name="activeDatetimeYN" value="Y" id="radiobyactivitydate"> Ngày giao dịch
									</td>
								</tr>
								<tr><td colspan="2"></td></tr>
								<tr>
									<td>Từ ngày
									</td>
									<td><input type="text" name="FromDate" value="24/10/2024" size="20" class="date-picker hasDatepicker" id="FromDate" maxlength="10"><img class="ui-datepicker-trigger" src="img/calendar.png" alt="Chọn ngày" title="Chọn ngày"></td>
								</tr>
								<tr>
									<td>Đến ngày
								
									</td>
									<td align="left">	<input type="text" name="ToDate" value="02/11/2024" size="20" class="date-picker hasDatepicker" id="ToDate" maxlength="10"><img class="ui-datepicker-trigger" src="img/calendar.png" alt="Chọn ngày" title="Chọn ngày"></td>
								</tr>
							
								<tr>
									<td colspan="2" align="center"><span style="padding-left: 0px; padding-right: 0px;">
										<input type="button" value="In sao kê" class="nut1 button-white" onclick="OutPrintByDate();">
										<input type="button" value="Xem" class="nut1 button-blue" onclick="SubmitByDate();"> 
										<input type="button" value="Xuất Excel" class="nut1 button-white" onclick="OutExByDate();"></span> 
										</td>
								</tr>
								</tbody>
							</table>
							</td>
						

						<form name="submitByMonth" method="post" action="Request"></form>
<input type="hidden" name="dse_sessionId" value="MmEpN2tR_gdSwvvVmqzlCvj">
<input type="hidden" name="dse_applicationId" value="-1">
<input type="hidden" name="dse_operationName" value="ibkacctDetailProc">
<input type="hidden" name="dse_pageId" value="5">
<input type="hidden" name="dse_processorState" value="acctDetailPage">
<input type="hidden" name="dse_processorId" value="JRCSIKCUHXGAFLHCJPANIEBYGIBZGYIGCWDIFEAR">
<input type="hidden" name="dse_errorPage" value="/ibk/acctinquiry/trans.jsp">


							<td>
							<table class="table-small">
								<tbody><tr>
									<td colspan="2">
										<input type="hidden" name="AccountNbr" id="AccountNbr" value="">
										<input type="hidden" name="virtualAccount" id="virtualAccount" value="">
										<input type="hidden" name="storeName" id="storeName" value="">
										<input type="hidden" name="CheckRef" id="CheckRef" value="">
										<input type="hidden" name="EdtRef" id="EdtRef" value="">
										<input type="hidden" name="dse_nextEventName" value="byMonth" id="chooseByMonth">
										Theo tháng
										&nbsp;&nbsp;&nbsp;&nbsp;<input type="radio" name="activeDatetimeByMonth" value="N" id="activeDatetimeByMonth" checked="checked" disabled="true"> Ngày hiệu lực
									</td>
								</tr>
								<tr><td colspan="2"></td></tr>

								<tr>
									<td>Tháng</td>
									<td>
									<select name="MonthCurr" id="dsthang">
<option value="01">01</option>
<option value="02">02</option>
<option value="03">03</option>
<option value="04">04</option>
<option value="05">05</option>
<option value="06">06</option>
<option value="07">07</option>
<option value="08">08</option>
<option value="09">09</option>
<option value="10">10</option>
<option value="11" selected="selected">11</option>
<option value="12">12</option>
</select>
									
									</td>
								</tr>
								<tr>
									<td>
                              Năm
                              </td>
                              <td>
                              <select name="YearCurr" id="dsnam">
<option value="2021">2021</option>
<option value="2022">2022</option>
<option value="2023">2023</option>
<option value="2024" selected="selected">2024</option>
</select>
									</td>
									
								</tr>
							
								<tr>
									<td colspan="2" align="center"><span style="padding-left: 0px; padding-right: 0px;"> 
										<input type="button" value="In sao kê" class="nut1 button-white" onclick="OutPrintByMonth();">
										<input type="button" value="Xem" class="nut1 button-blue" onclick="SubmitByMonth();"> 
										<input type="button" value="Xuất Excel" class="nut1 button-white" onclick="OutExByMonth();"></span></td>
								</tr>
							
							</tbody></table>
							</td>
						


					</tr>
				</tbody></table>
				</td>
			</tr>
			<tr>
				<form name="main1" method="post" action="Request"></form>
<input type="hidden" name="dse_sessionId" value="MmEpN2tR_gdSwvvVmqzlCvj">
<input type="hidden" name="dse_applicationId" value="-1">
<input type="hidden" name="dse_operationName" value="ibkacctDetailProc">
<input type="hidden" name="dse_pageId" value="5">
<input type="hidden" name="dse_processorState" value="acctDetailPage">
<input type="hidden" name="dse_processorId" value="JRCSIKCUHXGAFLHCJPANIEBYGIBZGYIGCWDIFEAR">
<input type="hidden" name="dse_errorPage" value="/ibk/login.jsp">


					<td colspan="3" align="center" class="menu2">
					<input type="checkbox" name="CheckRef" value="true"> <strong>Liệt kê theo số tham chiếu</strong> &nbsp;&nbsp;&nbsp;&nbsp; <input type="text" name="EdtRef" value="" size="20"></td>
				

			</tr>
			<tr>
				<td align="center"></td>
			</tr>
		
			
			
			
			
			<tr>
				<td colspan="6" align="right" class="success red_tieude">Số dư đầu:
				<span class="red_tieude">315.352
				(VND)</span></td>
			</tr>
			
			
			<tr>
				<td align="left">
					
					
					<table class="table-style-double1" cellspacing="1" cellpadding="0" id="table1">
<caption></caption>
<tbody><tr class="table-style-double1 tr-header">
	<th class="table-style-double1" align="center">Ngày hiệu lực</th>
	<th class="table-style-double1" align="center">Ngày giao dịch</th>
	<th class="table-style-double1" align="center">Số GD</th>
	<th class="table-style-double1" align="center">Ghi nợ</th>
	<th class="table-style-double1" align="center">Ghi có</th>
	<th class="table-style-double1" align="center">Số dư</th>
</tr>
<tr class="table-style-double1 odd">
	<td class="table-style-double1" align="center">02/11/2024</td>
	<td class="table-style-double1" align="center">01/11/2024 23:37:01</td>
	<td class="table-style-double1" align="center">2832</td>
	<td class="table-style-double1" align="right">&nbsp;</td>
	<td class="table-style-double1" align="right">20.000</td>
	<td class="table-style-double1" align="right">335.352</td>
</tr>
<tr class="table-style-double1 odd">
	<td class="table-style-double1" align="center"></td><td class="acctSum" align="left" colspan="4">DO HUYNH DUC CHUYEN TIEN GD 079121-110124 23:37:00</td><!--</td>
	<td class="table-style-double1" align="center" width="18%">&nbsp;</td>
	<td class="table-style-double1" align="center" width="15%">&nbsp;</td>
	<td class="table-style-double1" align="right" width="17%">&nbsp;</td>
	<td class="table-style-double1" align="right" width="17%">&nbsp;</td>
	<td class="table-style-double1" align="right" width="19%">--><td class="acctSum" align="left"></td>
</tr>
</tbody></table>
								
                </td>
            </tr>
                
                <tr>
                    <td colspan="6" align="right"><span class="red_tieude">
                    Tổng rút ra: 0
                    (VND) </span>
                    &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
                    <span class="red_tieude"> Tổng gửi vào:
                    20.000 (VND)
                    </span></td>
                </tr>
			
                <tr>
                    <td colspan="6" align="right" class="success red_tieude">Số dư cuối:
                    <span class="red_tieude">335.352
                    (VND)</span></td>
                </tr>
                
    		
			
			

		</tbody></table>
	
              <!-- InstanceEndEditable -->
			    </div>`;

      const result = service.parseAcbHistory(html);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: new Date('2024-11-01T16:37:01.000Z'),
        transaction_id: 'acbbank-2832',
        amount: 20000,
        content: 'DO HUYNH DUC CHUYEN TIEN GD 079121-110124 23:37:00',
        gate: GateType.ACBBANK,
        account_receiver: mockConfig.account,
      });
    });

    it('should handle empty table', () => {
      const html = `
        <table class="table-style-double1" cellspacing="1" cellpadding="0" id="table1">
          <tbody><tr class="table-style-double1 tr-header">
            <th class="table-style-double1" align="center">Ngày hiệu lực</th>
            <th class="table-style-double1" align="center">Ngày giao dịch</th>
            <th class="table-style-double1" align="center">Số GD</th>
            <th class="table-style-double1" align="center">Ghi nợ</th>
            <th class="table-style-double1" align="center">Ghi có</th>
            <th class="table-style-double1" align="center">Số dư</th>
          </tr>
          </tbody>
        </table>`;

      const result = service.parseAcbHistory(html);
      expect(result).toHaveLength(0);
    });
  });

  // Additional tests for the Gate class methods if needed
  describe('Gate base class functionality', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should have config initialized', () => {
      expect(service['config']).toBeDefined();
      expect(service['config'].account).toBe('test-account');
    });
  });
});
