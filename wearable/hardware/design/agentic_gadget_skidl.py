"""Agentic Voice Wearable - circuit as code (SKiDL) -> KiCad netlist.
All pins / values / voltages taken from the component datasheets in /Datasheets.
Rails: VBAT (LiPo 3.0-4.2V), 3V3, 1V8, GND."""
from pathlib import Path
from skidl import Part, Pin, Net, SKIDL, generate_netlist, ERC
import os, shutil

OUTDIR = str(Path(__file__).resolve().parent)
os.makedirs(OUTDIR, exist_ok=True)

def IC(name, ref, pin_names, fp, value=None):
    pins = [Pin(num=str(i+1), name=nm) for i, nm in enumerate(pin_names)]
    p = Part(name=name, ref_prefix=ref, tool=SKIDL, pins=pins, footprint=fp)
    if value: p.value = value
    return p
def R(val): return IC('R','R',['1','2'],'Resistor_SMD:R_0402_1005Metric',val)
def C(val): return IC('C','C',['1','2'],'Capacitor_SMD:C_0402_1005Metric',val)
def NET(name, *conns):
    n = Net(name); n += conns; return n

# ---- Parts (pin names from datasheets) ----
SOM  = IC('Icarus_SoM_nRF9160','U',
          ['VIN','VCC','GND','P0_SCK','P1_LRCK','P2_SDOUT','P3_PDMCLK','P4_PDMDAT',
           'SDA','SCL','P5_EN','P6_BTN','P7_LED','P8_STAT','uFL_ANT'],'Actinius:Icarus_SoM')
USB  = IC('USB4085_USB_C','J',['VBUS','GND','CC1','CC2','DP','DN'],'GCT:USB4085-GF-A')
CHG  = IC('MCP73831','U',['STAT','VSS','VBAT','VDD','PROG'],'Package_TO_SOT_SMD:SOT-23-5')
BATT = IC('LiPo_3V7','BT',['+','-'],'Battery:JST_PH_S2B')
LDO3 = IC('AP2112_3V3','U',['VIN','GND','EN','NC','VOUT'],'Package_TO_SOT_SMD:SOT-23-5')
LDO18= IC('XC6206_1V8','U',['VIN','GND','VOUT'],'Package_TO_SOT_SMD:SOT-23-3')
AMP  = IC('MAX98357A','U',['VDD','GND','BCLK','LRCLK','DIN','GAIN_SLOT','SD_MODE','OUTP','OUTN'],'Analog:MAX98357A_TQFN')
SPK  = IC('Speaker_8ohm','LS',['1','2'],'Audio:Speaker')
SHIFT= IC('TXB0102','U',['VCCA','VCCB','GND','OE','A1','A2','B1','B2'],'Package_SO:VSSOP-8')
MIC  = IC('T5837_PDM_mic','MK',['VDD','GND','CLK','DATA','SELECT'],'Sensor_Audio:T5837')
DRV  = IC('DRV2605L','U',['VDD','GND','REG','EN','IN_TRIG','SCL','SDA','OUTP','OUTN'],'Package_SO:VSSOP-10')
LRA  = IC('LRA_VLV101040A','M',['1','2'],'Actuator:LRA')
LED  = IC('SK6812','D',['VDD','GND','DIN','DOUT'],'LED_SMD:LED_SK6812_PLCC4_5.0x5.0mm')
BTN  = IC('Button_B3F','SW',['1','2'],'Button_Switch_SMD:SW_SPST')

# ---- Rails ----
VBAT=Net('VBAT'); V3V3=Net('+3V3'); V1V8=Net('+1V8'); GND=Net('GND'); VBUS=Net('VBUS')

# ---- Power & charging ----
VBUS += USB['VBUS'], CHG['VDD']
GND  += USB['GND'], CHG['VSS'], BATT['-'], SOM['GND'], AMP['GND'], SHIFT['GND'], MIC['GND'], DRV['GND'], LED['GND'], LDO3['GND'], LDO18['GND']
rc1=R('5.1k'); rc2=R('5.1k')
NET('CC1', USB['CC1'], rc1[1]); rc1[2]+=GND
NET('CC2', USB['CC2'], rc2[1]); rc2[2]+=GND
cin=C('4.7uF'); VBUS+=cin[1]; cin[2]+=GND
rprog=R('2k'); CHG['PROG']+=rprog[1]; rprog[2]+=GND
VBAT += CHG['VBAT'], BATT['+'], SOM['VIN'], AMP['VDD'], LDO3['VIN'], LED['VDD'], AMP['SD_MODE']
for cv in ['4.7uF','100uF','10uF']:
    c=C(cv); VBAT+=c[1]; c[2]+=GND
SOM['P8_STAT'] += CHG['STAT']
LDO3['EN'] += VBAT
V3V3 += LDO3['VOUT'], SOM['VCC'], DRV['VDD'], SHIFT['VCCB'], LDO18['VIN'], SHIFT['OE']
c33=C('1uF'); V3V3+=c33[1]; c33[2]+=GND
V1V8 += LDO18['VOUT'], MIC['VDD'], SHIFT['VCCA']
c18=C('1uF'); V1V8+=c18[1]; c18[2]+=GND
cmic=C('0.1uF'); MIC['VDD']+=cmic[1]; cmic[2]+=GND

# ---- Audio: I2S MCU -> amp ; speaker differential ----
NET('BCLK',  SOM['P0_SCK'],  AMP['BCLK'])
NET('LRCLK', SOM['P1_LRCK'], AMP['LRCLK'])
NET('I2S_DIN', SOM['P2_SDOUT'], AMP['DIN'])
NET('SPK_P', AMP['OUTP'], SPK['1'])
NET('SPK_N', AMP['OUTN'], SPK['2'])
# GAIN_SLOT left open = 9 dB ; SD_MODE->VBAT = mono (already)

# ---- PDM mic via TXB0102 level shifter (1V8 <-> 3V3) ----
NET('PDM_CLK_3V3', SOM['P3_PDMCLK'], SHIFT['B1'])
NET('PDM_DAT_3V3', SOM['P4_PDMDAT'], SHIFT['B2'])
NET('PDM_CLK_1V8', SHIFT['A1'], MIC['CLK'])
NET('PDM_DAT_1V8', SHIFT['A2'], MIC['DATA'])
MIC['SELECT'] += GND

# ---- I2C (4.7k pullups -> 3V3) ----
SDA=NET('SDA', SOM['SDA'], DRV['SDA']); SCL=NET('SCL', SOM['SCL'], DRV['SCL'])
rsda=R('4.7k'); SDA+=rsda[1]; rsda[2]+=V3V3
rscl=R('4.7k'); SCL+=rscl[1]; rscl[2]+=V3V3
creg=C('1uF'); DRV['REG']+=creg[1]; creg[2]+=GND
cdrv=C('1uF'); DRV['VDD']+=cdrv[1]; cdrv[2]+=GND
DRV['EN'] += SOM['P5_EN']; DRV['IN_TRIG'] += GND
NET('DRV_OUTP', DRV['OUTP'], LRA[1]); NET('DRV_OUTN', DRV['OUTN'], LRA[2])

# ---- Button + LED ----
NET('BTN_N', SOM['P6_BTN'], BTN[1]); BTN[2] += GND
NET('LED_DIN', SOM['P7_LED'], LED['DIN'])
cled=C('0.1uF'); LED['VDD']+=cled[1]; cled[2]+=GND

try: ERC()
except Exception as e: print("ERC note:", repr(e)[:100])
generate_netlist(file_=os.path.join(OUTDIR,"agentic_gadget.net"))
print("NETLIST OK")
try:
    from skidl import generate_svg; generate_svg(file_=os.path.join(OUTDIR,"agentic_gadget"))
    print("SVG OK")
except Exception as e: print("SVG skip:", repr(e)[:120])
shutil.copy(os.path.abspath(__file__), os.path.join(OUTDIR,"agentic_gadget_skidl.py"))
print("done")
